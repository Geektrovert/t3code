/**
 * PukuCliTextGeneration – Text generation layer using the Puku CLI.
 *
 * Structurally a clone of `ClaudeTextGeneration.ts`. puku-cli mirrors the
 * Claude Code CLI flag surface, so the one-shot `--print --output-format
 * json --json-schema …` invocation works unchanged; only the binary path
 * and a handful of model-resolution helpers differ.
 *
 * puku-cli's full model-id namespace resolves to the same Anthropic backend
 * by default (it honors `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, etc.),
 * so we currently reuse the Claude catalog with puku-friendly slugs
 * (`sonnet`, `opus`, `haiku`). When the bundled puku catalog diverges,
 * swap `BUNDLED_PUKU_CLI_MODEL_CATALOG` without touching the call sites.
 *
 * @module PukuCliTextGeneration
 */
import { type ModelSelection, PukuCliSettings, TextGenerationError } from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  BUNDLED_PUKU_CLI_MODEL_CATALOG,
  type PukuCliModelCatalog,
  resolvePukuCliModelSlug,
} from "../provider/PukuCliModelCatalog.ts";
import { makePukuCliEnvironment } from "../provider/Drivers/PukuCliHome.ts";

const PUKU_TIMEOUT_MS = 180_000;

/**
 * Schema for the wrapper JSON returned by `puku-cli -p --output-format json`.
 * Mirrors `ClaudeOutputEnvelope` (puku-cli is a clone of Claude Code's wire
 * format).
 */
const PukuOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});
const PukuOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isPukuOutputEnvelope = Schema.is(PukuOutputEnvelope);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodePukuOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([PukuOutputEnvelope, Schema.Array(PukuOutputMessage)])),
);

export const makePukuCliTextGeneration = Effect.fn("makePukuCliTextGeneration")(function* (
  pukuCliSettings: PukuCliSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<PukuCliModelCatalog> = Effect.succeed(BUNDLED_PUKU_CLI_MODEL_CATALOG),
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const pukuEnvironment = yield* makePukuCliEnvironment(pukuCliSettings, environment);

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("puku-cli", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  /**
   * Spawn the Puku CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runPukuJson = Effect.fn("runPukuJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const catalog = yield* modelCatalog;
    const resolvedModelSelection = {
      ...modelSelection,
      model: resolvePukuCliModelSlug(catalog, modelSelection.model),
    };
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    const caps = catalog.models.find((entry) => entry.model.slug === resolvedModelSelection.model)
      ?.model.capabilities ?? null;
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: resolvedModelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(resolvedModelSelection, "effort");
    const cliEffort =
      typeof rawEffortSelection === "string" && rawEffortSelection.length > 0
        ? rawEffortSelection
        : undefined;
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    const thinking =
      thinkingDescriptor?.type === "boolean" ? thinkingDescriptor.currentValue : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const settings = {
      disableAllHooks: true,
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
    };
    const settingsJson = yield* encodeJsonForOperation(
      operation,
      settings,
      "Failed to encode Puku CLI settings.",
    );

    const runPukuCommand = Effect.fn("runPukuJson.runPukuCommand")(function* () {
      // Titles need only the supplied prompt, not configuration from the checkout.
      const workingDirectory =
        operation === "generateThreadTitle"
          ? yield* fileSystem
              .makeTempDirectoryScoped({ prefix: "t3code-puku-title-" })
              .pipe(
                Effect.mapError((cause) =>
                  normalizeCliError("puku-cli", operation, cause, "Failed to create title directory"),
                ),
              )
          : cwd;
      const launchArgs = parseLaunchArgs(pukuCliSettings.launchArgs);
      const spawnCommand = yield* resolveSpawnCommand(
        pukuCliSettings.binaryPath || "puku-cli",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolvedModelSelection.model,
          ...(cliEffort ? ["--effort", cliEffort] : []),
          "--settings",
          settingsJson,
          // Metadata prompts need no executable capabilities, even when they contain a skill name.
          "--tools",
          "",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--permission-mode",
          "dontAsk",
          ...(pukuCliSettings.bareMode ? ["--bare"] : []),
          ...launchArgs,
        ],
        { env: pukuEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: pukuEnvironment,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("puku-cli", operation, cause, "Failed to spawn Puku CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("puku-cli", operation, cause, "Failed to read Puku CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Puku CLI command failed: ${detail}`
              : `Puku CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runPukuCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(PUKU_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Puku CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const output = yield* decodePukuOutput(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Puku CLI returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );
    const envelope = isPukuOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");

    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(envelope?.structured_output).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Puku CLI returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGeneration service methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PukuCliTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runPukuJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PukuCliTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runPukuJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PukuCliTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runPukuJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PukuCliTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runPukuJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});

/**
 * Split the user's `launchArgs` (whitespace-separated string) into argv tokens,
 * honoring double-quoted segments so paths-with-spaces survive. Matches the
 * pragmatic shell-split used by other drivers' launch-args plumbing.
 */
function parseLaunchArgs(value: string): ReadonlyArray<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const out: Array<string> = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null = re.exec(trimmed);
  while (match !== null) {
    const token = match[1] !== undefined ? match[1] : match[2] ?? "";
    if (token.length > 0) out.push(token);
    match = re.exec(trimmed);
  }
  return out;
}
