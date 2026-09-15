/**
 * PukuCliProvider — status probe for the Puku CLI driver.
 *
 * Mirrors `ClaudeProvider.ts` and `CursorProvider.ts`. Two CLI probes:
 *
 *   1. `puku-cli --version` — confirms the binary is on PATH and returns
 *      a parseable semver (puku-cli v1.8.56 prints `1.8.56`).
 *   2. `puku-cli auth status` — returns a JSON envelope with the
 *      authenticated account email + auth method when the user is
 *      signed in, or a non-zero exit when they're not.
 *
 * The second probe is best-effort: when it fails (older puku-cli
 * versions, sandboxed environments that can't reach the auth server),
 * the snapshot reports `auth.status = "unknown"` with a helpful
 * message — same shape as the Claude fallback.
 *
 * @module provider/Layers/PukuCliProvider
 */
import {
  type ModelCapabilities,
  type PukuCliSettings,
  type ServerProvider,
  ProviderDriverKind,
  type ServerProviderAuth,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  BUNDLED_PUKU_CLI_MODEL_CATALOG,
  type PukuCliModelCatalog,
  resolvePukuCliModelSlug,
  scopePukuCliModelCatalog,
} from "../PukuCliModelCatalog.ts";
import { makePukuCliEnvironment, pukuCliSignedOutMessage } from "../Drivers/PukuCliHome.ts";
import { resolvePukuCliHomePath } from "../Drivers/PukuCliHome.ts";

const PUKU_CLI_DRIVER_KIND = ProviderDriverKind.make("pukuAgent");

const PUKU_CLI_PRESENTATION = {
  displayName: "Puku CLI",
  badgeLabel: "Preview",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * Wire shape of `puku-cli auth status` JSON output (best-effort — puku-cli
 * does not publish a strict schema for this command, so we accept any of
 * the well-known account fields). If parsing fails we still report
 * "authenticated" based on the command's exit code.
 */
const PukuCliAuthStatus = Schema.Struct({
  email: Schema.optional(Schema.String),
  loggedIn: Schema.optional(Schema.Boolean),
  authMethod: Schema.optional(Schema.String),
  subscriptionType: Schema.optional(Schema.String),
  apiProvider: Schema.optional(Schema.String),
});
const decodePukuCliAuthStatus = Schema.decodeUnknownOption(PukuCliAuthStatus);

interface PukuCliAuthProbe {
  readonly status: Exclude<ServerProviderAuth["status"], "unknown">;
  readonly email?: string;
  readonly authMethod?: string;
  readonly subscriptionType?: string;
  readonly apiProvider?: string;
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function pukuCliSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  if (!subscriptionType) return undefined;
  const normalized = subscriptionType.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized.includes("max")) return "Max";
  if (normalized.includes("pro")) return "Pro";
  if (normalized.includes("team")) return "Team";
  if (normalized.includes("enterprise")) return "Enterprise";
  return toTitleCaseWords(subscriptionType);
}

function buildPukuCliAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
  readonly apiProvider: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (input.authMethod?.toLowerCase().includes("apikey")) {
    return { type: "apiKey", label: "Puku API Key" };
  }
  if (input.apiProvider?.toLowerCase() === "bedrock") {
    return { type: "bedrock", label: "Amazon Bedrock" };
  }
  if (input.subscriptionType) {
    const label = pukuCliSubscriptionLabel(input.subscriptionType) ?? input.subscriptionType;
    return { type: input.subscriptionType, label: `${label} Subscription` };
  }
  return undefined;
}

/**
 * Try to parse `puku-cli auth status` JSON output. Returns undefined when
 * the command's stdout is not JSON; the caller falls back to the exit
 * code in that case.
 */
function parsePukuCliAuthOutput(
  result: { readonly stdout: string; readonly code: number },
): PukuCliAuthProbe | undefined {
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const decoded = decodePukuCliAuthStatus(parsed);
      if (decoded) {
        if (decoded.loggedIn === false) {
          return { status: "unauthenticated" };
        }
        const authMetadata = buildPukuCliAuthMetadata({
          subscriptionType: decoded.subscriptionType,
          authMethod: decoded.authMethod,
          apiProvider: decoded.apiProvider,
        });
        return {
          status: "authenticated",
          ...(decoded.email ? { email: decoded.email } : {}),
          ...(decoded.authMethod ? { authMethod: decoded.authMethod } : {}),
          ...(decoded.subscriptionType ? { subscriptionType: decoded.subscriptionType } : {}),
          ...(decoded.apiProvider ? { apiProvider: decoded.apiProvider } : {}),
          ...(authMetadata ? { authMethod: authMetadata.label } : {}),
        };
      }
    } catch {
      // Fall through to exit-code-based detection.
    }
  }
  if (result.code === 0) {
    return { status: "authenticated" };
  }
  const lower = result.stdout.toLowerCase();
  if (lower.includes("not logged in") || lower.includes("login required")) {
    return { status: "unauthenticated" };
  }
  return undefined;
}

const runPukuCliCommand = Effect.fn("runPukuCliCommand")(function* (
  pukuCliSettings: PukuCliSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pukuEnvironment = yield* makePukuCliEnvironment(pukuCliSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(pukuCliSettings.binaryPath, args, {
    env: pukuEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: pukuEnvironment,
    shell: spawnCommand.shell,
  });
  const child = yield* spawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.runFold(() => "", (acc, chunk) => acc + chunk)),
      child.stderr.pipe(Stream.decodeText(), Stream.runFold(() => "", (acc, chunk) => acc + chunk)),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, code: exitCode };
});

const AUTH_PROBE_TIMEOUT_MS = 10_000;
const VERSION_PROBE_TIMEOUT_MS = 4_000;

export const checkPukuCliProviderStatus = Effect.fn("checkPukuCliProviderStatus")(function* (
  pukuCliSettings: PukuCliSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: PukuCliModelCatalog = BUNDLED_PUKU_CLI_MODEL_CATALOG,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const scopedCatalog = scopePukuCliModelCatalog(modelCatalog, pukuCliSettings.customModels);
  const allModels = providerModelsFromSettings(
    scopedCatalog.models.map((entry) => entry.model),
    pukuCliSettings.customModels,
    EMPTY_CAPABILITIES,
  );

  if (!pukuCliSettings.enabled) {
    return buildServerProvider({
      presentation: PUKU_CLI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Puku CLI is disabled in T3 Code settings.",
      },
    });
  }

  // 1. Version probe — confirms the binary is on PATH.
  const versionProbe = yield* runPukuCliCommand(
    pukuCliSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Puku CLI version probe failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: PUKU_CLI_PRESENTATION,
      enabled: pukuCliSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `Puku CLI (\`${pukuCliSettings.binaryPath}\`) was not found on PATH.`
          : "Failed to execute Puku CLI version probe.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: PUKU_CLI_PRESENTATION,
      enabled: pukuCliSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Puku CLI is installed but timed out while running --version.",
      },
    });
  }

  const versionResult = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    yield* Effect.logWarning("Puku CLI --version exited with a non-zero status.", {
      exitCode: versionResult.code,
      stdoutLength: versionResult.stdout.length,
      stderrLength: versionResult.stderr.length,
    });
    return buildServerProvider({
      presentation: PUKU_CLI_PRESENTATION,
      enabled: pukuCliSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Puku CLI is installed but --version failed.",
      },
    });
  }

  // 2. Auth probe — best-effort. Failure here never blocks the snapshot.
  const authProbeResult = yield* runPukuCliCommand(
    pukuCliSettings,
    ["auth", "status"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);

  let auth: ServerProviderAuth = { status: "unknown" };
  let authMessage: string | undefined;

  if (Result.isFailure(authProbeResult)) {
    yield* Effect.logDebug("Puku CLI auth probe failed; reporting unknown auth.", {
      errorTag: authProbeResult.failure._tag,
    });
    auth = { status: "unknown" };
  } else if (Option.isNone(authProbeResult.success)) {
    auth = { status: "unknown" };
    authMessage = "Puku CLI auth probe timed out.";
  } else {
    const authProbe = parsePukuCliAuthOutput(authProbeResult.success.value);
    if (authProbe === undefined) {
      auth = { status: "unknown" };
    } else if (authProbe.status === "unauthenticated") {
      const configDir = yield* resolvePukuCliHomePath(pukuCliSettings).pipe(Effect.option);
      auth = {
        status: "unauthenticated",
        ...(authProbe.email ? { email: authProbe.email } : {}),
      };
      authMessage = pukuCliSignedOutMessage({
        configDir: Option.isSome(configDir) ? configDir.value : undefined,
        cwd: cwd ?? process.cwd(),
      });
    } else {
      const authMetadata = buildPukuCliAuthMetadata({
        subscriptionType: authProbe.subscriptionType,
        authMethod: authProbe.authMethod,
        apiProvider: authProbe.apiProvider,
      });
      auth = {
        status: "authenticated",
        ...(authProbe.email ? { email: authProbe.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      };
    }
  }

  return buildServerProvider({
    presentation: PUKU_CLI_PRESENTATION,
    enabled: pukuCliSettings.enabled,
    checkedAt,
    models: allModels,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version: parsedVersion,
      status: auth.status === "unauthenticated" ? "error" : "ready",
      auth,
      ...(authMessage ? { message: authMessage } : {}),
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingPukuCliProvider = (
  pukuCliSettings: PukuCliSettings,
  modelCatalog: PukuCliModelCatalog = BUNDLED_PUKU_CLI_MODEL_CATALOG,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const scopedCatalog = scopePukuCliModelCatalog(modelCatalog, pukuCliSettings.customModels);
    const models = providerModelsFromSettings(
      scopedCatalog.models.map((entry) => entry.model),
      pukuCliSettings.customModels,
      EMPTY_CAPABILITIES,
    );

    if (!pukuCliSettings.enabled) {
      return buildServerProvider({
        presentation: PUKU_CLI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Puku CLI is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PUKU_CLI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Puku CLI provider status has not been checked in this session yet.",
      },
    });
  });

/**
 * Resolve the canonical slug puku-cli should receive for a given model
 * selection. Useful for adapters and the UI when the user typed an alias.
 */
export function resolvePukuCliCatalogModelId(
  catalog: PukuCliModelCatalog,
  modelSelection: { model: string },
): string {
  return resolvePukuCliModelSlug(catalog, modelSelection.model);
}

export { PUKU_CLI_DRIVER_KIND };
