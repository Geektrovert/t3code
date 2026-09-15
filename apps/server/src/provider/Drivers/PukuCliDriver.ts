/**
 * PukuCliDriver — `ProviderDriver` for the Puku CLI runtime.
 *
 * Mirrors `ClaudeDriver.ts`. One driver factory yields one
 * `ProviderInstance` bundling snapshot / adapter / textGeneration
 * closures captured over the per-instance `PukuCliSettings`.
 *
 * puku-cli is a near-clone of Claude Code CLI, so the structure here is
 * intentionally identical to `ClaudeDriver.ts`. Two CLI deltas:
 *
 *   1. `permissionMode` includes the puku-specific `auto` mode (not in
 *      Claude Code's enum). The driver preserves this on `--permission-mode`.
 *   2. `bareMode` (boolean setting) forwards `--bare` to puku-cli to skip
 *      hooks / LSP / plugin sync / auto-memory / CLAUDE.md auto-discovery.
 *      Useful for sandboxed server runs.
 *
 * @module provider/Drivers/PukuCliDriver
 */
import {
  PukuCliSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makePukuCliTextGeneration } from "../../textGeneration/PukuCliTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { resolvePukuCliModelSlug } from "../PukuCliModelCatalog.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  BUNDLED_PUKU_CLI_MODEL_CATALOG,
  type PukuCliModelCatalog,
} from "../PukuCliModelCatalog.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  makePukuCliCapabilitiesCacheKey,
  makePukuCliContinuationGroupKey,
} from "./PukuCliHome.ts";
import {
  checkPukuCliProviderStatus,
  makePendingPukuCliProvider,
} from "../Layers/PukuCliProvider.ts";
import { makePukuCliAdapter } from "../Layers/PukuCliAdapter.ts";

const decodePukuCliSettings = Schema.decodeSync(PukuCliSettings);

const DRIVER_KIND = ProviderDriverKind.make("pukuAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

function isPukuCliNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.bun/bin/puku-cli") ||
    normalized.endsWith("/.local/bin/puku-cli") ||
    normalized.endsWith("/.local/bin/puku-cli.exe") ||
    normalized.includes("/.bun/install/global/node_modules/@puku/puku-cli/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@puku/puku-cli",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isPukuCliNativeCommandPath,
  },
});

export type PukuCliDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

function resolvePukuCliModelCatalog(
  catalog: PukuCliModelCatalog,
  modelSelection: { model: string } | undefined,
  customModels: ReadonlyArray<ServerProviderModel>,
): PukuCliModelCatalog {
  // Resolve any aliases to canonical slugs so the adapter always sees a
  // slug the bundled catalog knows about.
  const resolved = modelSelection
    ? resolvePukuCliModelSlug(catalog, modelSelection.model)
    : undefined;
  return {
    models: [
      ...catalog.models.map((entry) =>
        resolved !== undefined && entry.model.slug === resolved
          ? { ...entry, model: { ...entry.model, isDefault: true } }
          : entry,
      ),
      ...customModels.map((model) => ({ model })),
    ],
  };
}

export const PukuCliDriver: ProviderDriver<PukuCliSettings, PukuCliDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Puku CLI",
    supportsMultipleInstances: true,
  },
  configSchema: PukuCliSettings,
  defaultConfig: (): PukuCliSettings => decodePukuCliSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const { cwd } = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const modelCatalog = modelManifest.current.pipe(
        Effect.map(() => BUNDLED_PUKU_CLI_MODEL_CATALOG),
      );
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies PukuCliSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const continuationGroupKey = yield* makePukuCliContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const adapterOptions = {
        instanceId,
        modelCatalog,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      };
      const adapter = yield* makePukuCliAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makePukuCliTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
      );

      // Per-instance capabilities cache keyed on binary + resolved HOME so
      // account metadata never crosses instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          // The capabilities probe currently piggybacks on the snapshot
          // check; puku-cli doesn't expose an SDK-style init result, so
          // the probe is effectively a no-op until we wire in puku's own
          // `auth status` JSON.
          Effect.succeed(undefined as undefined),
      });
      const capabilitiesCacheKey = yield* makePukuCliCapabilitiesCacheKey(effectiveConfig, cwd);

      const checkProvider = modelManifest.refreshInBackground.pipe(
        Effect.andThen(
          modelManifest.current.pipe(
            Effect.flatMap(() =>
              checkPukuCliProviderStatus(effectiveConfig, processEnv, cwd),
            ),
            Effect.map(stampIdentity),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PukuCliSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () =>
          modelManifest.current.pipe(
            Effect.flatMap(() => makePendingPukuCliProvider(effectiveConfig)),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Puku CLI snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
