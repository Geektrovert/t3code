import * as NodeOS from "node:os";

import type { PukuCliSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Resolve the per-instance Puku config dir. puku-cli auto-detects
 * `~/.puku-cli/` by default; an empty `homePath` falls back to the user's
 * real home (puku-cli's own default). Setting a custom path is the only
 * way to isolate two instances on the same machine.
 */
export const resolvePukuCliHomePath = Effect.fn("resolvePukuCliHomePath")(function* (
  config: Pick<PukuCliSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

/**
 * Build the spawned CLI's environment. puku-cli does not expose a
 * `CLAUDE_CONFIG_DIR`-style override (no equivalent flag in `--help`),
 * so per-instance isolation has to come from `--settings <path>` (the
 * `homePath` value is also forwarded as a default `--settings` arg in
 * the adapter, mirroring Claude's env override pattern).
 *
 * When `homePath` is empty we leave the environment untouched so the
 * CLI inherits the user's normal `~/.puku-cli/` config.
 */
export const makePukuCliEnvironment = Effect.fn("makePukuCliEnvironment")(function* (
  config: Pick<PukuCliSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolvePukuCliHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Surface the config dir to the CLI. puku-cli auto-detects HOME, but a
    // non-default location is honored by the standard `~/.puku-cli` lookup
    // only when HOME points there. Keeping HOME out of the override avoids
    // the macOS keychain relocation issue documented in ClaudeHome.ts.
    PUKU_CLI_HOME: resolvedHomePath,
  };
});

/**
 * Cache key for per-instance identity (used for continuation groups so
 * two puku-cli instances with distinct home dirs do not collide).
 */
export const makePukuCliContinuationGroupKey = Effect.fn("makePukuCliContinuationGroupKey")(
  function* (config: Pick<PukuCliSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolvePukuCliHomePath(config);
    return `puku:home:${resolvedHomePath}`;
  },
);

/**
 * Cache key for capability probes. The binary + HOME pair is enough to
 * guarantee two instances never share auth metadata.
 */
export const makePukuCliCapabilitiesCacheKey = Effect.fn("makePukuCliCapabilitiesCacheKey")(
  function* (
    config: Pick<PukuCliSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolvePukuCliHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Friendly message when the auth probe (or session start) reports the
 * user is not logged in. Mirrors `claudeSignedOutMessage` so the wizard
 * stays consistent across the two providers.
 */
export const pukuCliSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${JSON.stringify(input.cwd)}, with PUKU_CLI_HOME set to ${JSON.stringify(input.configDir)}`
      : "";
  return `Puku CLI could not authenticate. For subscription login, run \`puku-cli auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
