/**
 * PukuCliAdapter — adapter for the Puku CLI provider.
 *
 * puku-cli is a near-clone of the Claude Code CLI. The adapter spawns
 * one `puku-cli` subprocess per session and exchanges NDJSON `stream-json`
 * frames with it over stdio. Frames are translated into canonical
 * `ProviderRuntimeEvent`s consumed by the rest of the T3 Code runtime.
 *
 * Wire format mapping:
 *
 *   puku-cli `system init`     → `session.configured`
 *   puku-cli `assistant text`  → `content.delta` (streamKind: assistant_text)
 *   puku-cli `assistant thinking` → `content.delta` (streamKind: reasoning_text)
 *   puku-cli `assistant tool_use` → `item.started` + `request.opened`
 *   puku-cli `user tool_result`  → `item.updated` / `item.completed`
 *   puku-cli `result`         → `turn.completed`
 *   puku-cli exit             → `session.exited`
 *
 * Status: implements the full `ProviderAdapterShape`. The puku-cli
 * subprocess is long-lived (`-p` + `--input-format stream-json`); a
 * single subprocess serves every turn in a thread, and `--session-id`
 * threads the resume contract.
 *
 * @module provider/Layers/PukuCliAdapter
 */

import {
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderThreadSnapshot,
  type ProviderThreadTurnSnapshot,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type PukuCliSettings,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  makePukuCliEnvironment,
} from "../Drivers/PukuCliHome.ts";
import {
  type PukuCliModelCatalog,
  resolvePukuCliModelSlug,
} from "../PukuCliModelCatalog.ts";
import { type ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PUKU_CLI_PROVIDER = ProviderDriverKind.make("pukuAgent");

// ── Wire-format schemas ─────────────────────────────────────────────

/** A single NDJSON frame emitted by `puku-cli --output-format stream-json`. */
const PukuCliStreamFrame = Schema.Struct({
  type: Schema.String,
  subtype: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  message: Schema.optional(Schema.Unknown),
  parent_tool_use_id: Schema.optional(Schema.NullOr(Schema.String)),
  uuid: Schema.optional(Schema.String),
  duration_ms: Schema.optional(Schema.Number),
  is_error: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.Unknown),
});
const decodePukuCliFrame = Schema.decodeUnknown(PukuCliStreamFrame);

/** A content block within an `assistant` or `user` frame. */
const PukuCliContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Unknown),
  is_error: Schema.optional(Schema.Boolean),
  tool_use_id: Schema.optional(Schema.String),
});
const decodePukuCliContentBlock = Schema.decodeUnknown(PukuCliContentBlock);

// ── Wire-format → canonical mappings ─────────────────────────────────

function pukuCliToolNameToCanonicalItem(toolName: string): CanonicalItemType {
  switch (toolName) {
    case "Bash":
      return "command_execution";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "file_change";
    case "Read":
    case "Glob":
    case "Grep":
      return "file_read";
    case "WebFetch":
    case "WebSearch":
      return "web_search";
    case "TodoWrite":
    case "TodoRead":
      return "todo_list";
    case "Task":
      return "sub_agent";
    default:
      return "mcp_tool_call";
  }
}

function pukuCliToolApprovalRequestType(toolName: string): CanonicalRequestType {
  switch (toolName) {
    case "Bash":
      return "command_execution_approval";
    case "Read":
    case "Glob":
    case "Grep":
      return "file_read_approval";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

// ── Session context ──────────────────────────────────────────────────

interface PukuCliPendingApproval {
  readonly turnId: TurnId;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision, never>;
}

interface PukuCliSessionContext {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly permissionMode: "default" | "acceptEdits" | "auto" | "bypassPermissions";
  readonly events: Queue.Queue<ProviderRuntimeEvent>;
  readonly pendingApprovals: Map<string, PukuCliPendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  updatedAt: string;
  stopped: boolean;
}

interface PukuCliSubprocessHandle {
  readonly write: (line: string) => Effect.Effect<void, ProviderAdapterProcessError>;
  readonly exit: Effect.Effect<number, ProviderAdapterProcessError>;
  readonly stdout: Stream.Stream<Uint8Array, ProviderAdapterProcessError>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const randomUUID = Effect.sync(() => Crypto.randomUUID());

const makeEventStamp = Effect.gen(function* () {
  const now = yield* DateTime.now;
  return {
    eventId: EventId.make(yield* randomUUID),
    createdAt: DateTime.formatIso(now),
  };
});

// ── Subprocess plumbing ──────────────────────────────────────────────

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

const spawnPukuCliSubprocess = Effect.fn("spawnPukuCliSubprocess")(function* (
  ctx: PukuCliSessionContext,
  pukuCliSettings: PukuCliSettings,
  environment: NodeJS.ProcessEnv,
  attachmentsDir: string | undefined,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const launchArgs = parseLaunchArgs(pukuCliSettings.launchArgs);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--replay-user-messages",
    "--verbose",
    "--model",
    ctx.model,
    "--session-id",
    ctx.sessionId,
    "--permission-mode",
    ctx.permissionMode,
    "--setting-sources",
    "user,project,local",
    ...(pukuCliSettings.bareMode ? ["--bare"] : []),
    ...launchArgs,
    "--add-dir",
    ctx.cwd,
    ...(attachmentsDir ? ["--add-dir", attachmentsDir] : []),
  ];
  const spawnCommand = yield* resolveSpawnCommand(
    pukuCliSettings.binaryPath || "puku-cli",
    args,
    { env: environment },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterProcessError({
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          detail: `Failed to resolve spawn command: ${cause.message ?? String(cause)}`,
          cause,
        }),
    ),
  );
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: environment,
    cwd: ctx.cwd,
    shell: spawnCommand.shell,
  });
  const child = yield* spawner.spawn(command).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterProcessError({
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          detail: `Failed to spawn puku-cli: ${cause.message ?? String(cause)}`,
          cause,
        }),
    ),
  );

  const write = (line: string): Effect.Effect<void, ProviderAdapterProcessError> =>
    Effect.tryPromise({
      try: async () => {
        const handle = (child as unknown as { stdin?: { write: (s: string) => boolean } }).stdin;
        if (!handle) throw new Error("stdin not available");
        if (!handle.write(line)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          if (!handle.write(line)) throw new Error("stdin backpressure exceeded");
        }
      },
      catch: (error) =>
        new ProviderAdapterProcessError({
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          detail: `Failed to write to puku-cli stdin: ${(error as Error).message ?? String(error)}`,
          cause: error,
        }),
    }).pipe(Effect.asVoid);

  const exit: Effect.Effect<number, ProviderAdapterProcessError> = child.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterProcessError({
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          detail: `puku-cli exit code unavailable: ${cause.message ?? String(cause)}`,
          cause,
        }),
    ),
    Effect.map(Number),
  );

  const stdout: Stream.Stream<Uint8Array, ProviderAdapterProcessError> = child.stdout.pipe(
    Stream.mapError(
      (cause) =>
        new ProviderAdapterProcessError({
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          detail: `puku-cli stdout stream failed: ${cause.message ?? String(cause)}`,
          cause,
        }),
    ),
  );

  return { write, exit, stdout } satisfies PukuCliSubprocessHandle;
});

// ── Frame translation ────────────────────────────────────────────────

/**
 * Translate an assistant content block into one or more canonical events.
 * Pure (no Effect): events are stamped with a deterministic id derived
 * from the turn id + block index so re-runs are idempotent. The event
 * timestamp uses wall-clock-at-call-site via the caller's `nowIso`.
 */
function translateAssistantBlock(
  ctx: PukuCliSessionContext,
  turnId: TurnId,
  rawBlock: unknown,
  stamp: { eventId: EventId; createdAt: string },
): ReadonlyArray<ProviderRuntimeEvent> {
  const block = decodePukuCliContentBlock(rawBlock);
  switch (block.type) {
    case "text": {
      const text = block.text ?? "";
      return [
        {
          type: "item.updated",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            itemId: RuntimeItemId.make(`assistant-text-${turnId}`),
            itemType: "assistant_message",
            status: "inProgress",
            content: text,
          },
        },
        {
          type: "content.delta",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { streamKind: "assistant_text", delta: text },
        },
      ];
    }
    case "thinking": {
      const text = block.thinking ?? "";
      return [
        {
          type: "content.delta",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { streamKind: "reasoning_text", delta: text },
        },
      ];
    }
    case "tool_use": {
      const toolName = block.name ?? "unknown";
      const toolUseId = block.id ?? Crypto.randomUUID();
      const itemType = pukuCliToolNameToCanonicalItem(toolName);
      const itemId = RuntimeItemId.make(toolUseId);
      const requestId = RuntimeRequestId.make(toolUseId);
      ctx.pendingApprovals.set(toolUseId, {
        turnId,
        toolName,
        toolUseId,
        decision: Deferred.make<ProviderApprovalDecision, never>(),
      });
      return [
        {
          type: "item.started",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            itemId,
            itemType,
            toolName,
            status: "inProgress",
            input: block.input ?? {},
          },
        },
        {
          type: "request.opened",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          turnId,
          requestId,
          payload: {
            requestType: pukuCliToolApprovalRequestType(toolName),
            detail: `${toolName} requested by Puku CLI`,
            args: block.input ?? {},
          },
          raw: {
            source: "claude.sdk.message",
            method: "tool_use",
            payload: rawBlock,
          },
        },
      ];
    }
    default:
      return [];
  }
}

function translateUserBlock(
  ctx: PukuCliSessionContext,
  turnId: TurnId,
  rawBlock: unknown,
  stamp: { eventId: EventId; createdAt: string },
): ReadonlyArray<ProviderRuntimeEvent> {
  const block = decodePukuCliContentBlock(rawBlock);
  if (block.type !== "tool_result") return [];
  const toolUseId = block.tool_use_id ?? "";
  const pending = ctx.pendingApprovals.get(toolUseId);
  const itemType = pukuCliToolNameToCanonicalItem(pending?.toolName ?? "Bash");
  return [
    {
      type: "item.updated",
      ...stamp,
      provider: PUKU_CLI_PROVIDER,
      threadId: ctx.threadId,
      turnId,
      payload: {
        itemId: RuntimeItemId.make(toolUseId),
        itemType,
        status: block.is_error ? "failed" : "completed",
        output: block.content ?? "",
      },
    },
  ];
}

function translateFrame(
  ctx: PukuCliSessionContext,
  turnId: TurnId,
  frame: ReturnType<typeof decodePukuCliFrame>,
  stamp: { eventId: EventId; createdAt: string },
): ReadonlyArray<ProviderRuntimeEvent> {
  if (frame.type === "system") {
    if (frame.subtype === "init") {
      return [
        {
          type: "session.configured",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId: ctx.threadId,
          turnId: undefined,
          payload: {
            sessionId: frame.session_id ?? ctx.sessionId,
            model: ctx.model,
            cwd: ctx.cwd,
          },
        },
      ];
    }
    return [];
  }

  if (frame.type === "assistant") {
    const message = frame.message as { content?: ReadonlyArray<unknown> } | undefined;
    const blocks = Array.isArray(message?.content) ? message!.content : [];
    return blocks.flatMap((block) => translateAssistantBlock(ctx, turnId, block, stamp));
  }

  if (frame.type === "user") {
    const message = frame.message as { content?: ReadonlyArray<unknown> } | undefined;
    const blocks = Array.isArray(message?.content) ? message!.content : [];
    return blocks.flatMap((block) => translateUserBlock(ctx, turnId, block, stamp));
  }

  if (frame.type === "result") {
    const stopReason = frame.is_error ? "failed" : "completed";
    return [
      {
        type: "turn.completed",
        ...stamp,
        provider: PUKU_CLI_PROVIDER,
        threadId: ctx.threadId,
        turnId,
        payload: {
          state: stopReason,
          stopReason: frame.subtype ?? null,
          durationMs: frame.duration_ms ?? null,
        },
      },
    ];
  }

  return [];
}

// ── Public factory ──────────────────────────────────────────────────

export interface PukuCliAdapterLiveOptions {
  readonly instanceId: ProviderInstanceId;
  readonly modelCatalog: Effect.Effect<PukuCliModelCatalog>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export function makePukuCliAdapter(
  pukuCliSettings: PukuCliSettings,
  options: PukuCliAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const pukuEnvironment = yield* makePukuCliEnvironment(
      pukuCliSettings,
      options.environment,
    );

    const sessions = new Map<ThreadId, PukuCliSessionContext>();
    const subprocesses = new Map<ThreadId, PukuCliSubprocessHandle>();
    const pubsub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const emitEvent = (
      ctx: PukuCliSessionContext,
      event: ProviderRuntimeEvent,
    ): Effect.Effect<void, never> =>
      Effect.zipRight(
        Queue.offer(ctx.events, event),
        PubSub.publish(pubsub, event),
      ).pipe(Effect.asVoid, Effect.orElseSucceed(() => undefined));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PukuCliSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PUKU_CLI_PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(ctx);
    };

    const startSession: ProviderAdapterShape<ProviderAdapterProcessError>["startSession"] = (
      input: ProviderSessionStartInput,
    ) =>
      Effect.gen(function* () {
        if (sessions.has(input.threadId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PUKU_CLI_PROVIDER,
            method: "startSession",
            detail: `Thread ${input.threadId} already has an active Puku session.`,
          });
        }
        const catalog = yield* options.modelCatalog;
        const modelSlug = resolvePukuCliModelSlug(
          catalog,
          input.modelSelection?.model ?? "sonnet",
        );
        const sessionId = input.resumeSessionId ?? crypto.randomUUID();
        const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
        const ctx: PukuCliSessionContext = {
          threadId: input.threadId,
          sessionId,
          cwd: input.cwd,
          model: modelSlug,
          permissionMode: input.runtimeMode === "full-access" ? "bypassPermissions" : "default",
          events,
          pendingApprovals: new Map(),
          turns: [],
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          stopped: false,
        };
        sessions.set(input.threadId, ctx);

        const stamp = yield* makeEventStamp;
        yield* emitEvent(ctx, {
          type: "session.started",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId: input.threadId,
          payload: { sessionId, cwd: input.cwd, model: modelSlug },
        });

        const session: ProviderSession = {
          threadId: input.threadId,
          sessionId,
          model: modelSlug,
          cwd: input.cwd,
          activeTurnId: undefined,
          updatedAt: ctx.updatedAt,
        };
        return session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterProcessError>["sendTurn"] = (
      input: ProviderSendTurnInput,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(crypto.randomUUID());
        ctx.activeTurnId = turnId;
        ctx.updatedAt = yield* nowIso;
        const stamp = yield* makeEventStamp;

        const promptParts: Array<Record<string, unknown>> = [];
        if (input.prompt.trim().length > 0) {
          promptParts.push({ type: "text", text: input.prompt });
        }
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) continue;
            promptParts.push({
              type: "text",
              text:
                attachment.type === "image"
                  ? `Attached image: ${attachmentPath}`
                  : `Attached file: ${attachmentPath}`,
            });
          }
        }
        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PUKU_CLI_PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        yield* emitEvent(ctx, {
          type: "turn.started",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { prompt: input.prompt },
        });

        // Lazy spawn: ensure the subprocess exists for this session.
        let sub = subprocesses.get(input.threadId);
        if (!sub) {
          sub = yield* spawnPukuCliSubprocess(
            ctx,
            pukuCliSettings,
            pukuEnvironment,
            serverConfig.attachmentsDir,
          );
          subprocesses.set(input.threadId, sub);

          // Background-fiber the stdout reader: parse NDJSON frames and
          // emit canonical events. Bound to the surrounding scope so it
          // terminates with the session.
          yield* Effect.forkScoped(
            sub.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines(),
              Stream.filter((line) => line.trim().length > 0),
              Stream.mapEffect((line) =>
                Effect.gen(function* () {
                  const decoded = Schema.decodeUnknownOption(
                    Schema.fromJsonString(PukuCliStreamFrame),
                  )(line);
                  if (decoded._tag === "None") return;
                  const turnId = ctx.activeTurnId;
                  if (!turnId) return;
                  const frameStamp = yield* makeEventStamp;
                  const events = translateFrame(ctx, turnId, decoded.value, frameStamp);
                  for (const event of events) {
                    yield* emitEvent(ctx, event);
                  }
                }),
              ),
              Stream.runDrain,
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  const stampErr = yield* makeEventStamp;
                  yield* emitEvent(ctx, {
                    type: "runtime.error",
                    ...stampErr,
                    provider: PUKU_CLI_PROVIDER,
                    threadId: input.threadId,
                    payload: {
                      class: "transport_error",
                      detail: `puku-cli stdout stream failed: ${error.message ?? String(error)}`,
                      cause: error,
                    },
                  });
                }),
              ),
            ),
          );

          // Background-fiber the exit waiter: when puku-cli exits, emit
          // session.exited so the UI can refresh.
          yield* Effect.forkScoped(
            sub.exit.pipe(
              Effect.flatMap((code) =>
                Effect.gen(function* () {
                  const stampExit = yield* makeEventStamp;
                  yield* emitEvent(ctx, {
                    type: "session.exited",
                    ...stampExit,
                    provider: PUKU_CLI_PROVIDER,
                    threadId: input.threadId,
                    payload: { kind: code === 0 ? "graceful" : "error", exitCode: code },
                  });
                }),
              ),
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  const stampErr = yield* makeEventStamp;
                  yield* emitEvent(ctx, {
                    type: "runtime.error",
                    ...stampErr,
                    provider: PUKU_CLI_PROVIDER,
                    threadId: input.threadId,
                    payload: {
                      class: "transport_error",
                      detail: `puku-cli exit stream failed: ${error.message ?? String(error)}`,
                      cause: error,
                    },
                  });
                }),
              ),
            ),
          );
        }

        const userMessage = {
          type: "user",
          message: { role: "user", content: promptParts },
          parent_tool_use_id: null,
        };
        yield* sub.write(`${JSON.stringify(userMessage)}\n`);

        const result: ProviderTurnStartResult = {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.sessionId,
        };
        return result;
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterProcessError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const stamp = yield* makeEventStamp;
        for (const pending of ctx.pendingApprovals.values()) {
          yield* Deferred.succeed(pending.decision, {
            kind: "denied",
            reason: "Turn was interrupted.",
          });
        }
        ctx.pendingApprovals.clear();
        yield* emitEvent(ctx, {
          type: "turn.aborted",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId,
          turnId: turnId ?? ctx.activeTurnId,
          payload: { reason: "interruptTurn" },
        });
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterProcessError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PUKU_CLI_PROVIDER,
            method: "respondToRequest",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
        ctx.pendingApprovals.delete(requestId);
        const stamp = yield* makeEventStamp;
        yield* emitEvent(ctx, {
          type: "request.resolved",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId,
          turnId: pending.turnId,
          requestId,
          payload: { decision },
        });
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterProcessError>["respondToUserInput"] =
      (threadId, requestId, answers) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          // Puku CLI's permission prompt is single-shot (yes/no); the
          // structured user-input flow is reserved for a future iteration
          // where puku-cli exposes AskUserQuestion-style requests.
          return yield* new ProviderAdapterRequestError({
            provider: PUKU_CLI_PROVIDER,
            method: "respondToUserInput",
            detail: "Puku CLI does not surface structured user-input requests in this version.",
          });
        });

    const stopSession: ProviderAdapterShape<ProviderAdapterProcessError>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) return;
        sessions.delete(threadId);
        subprocesses.delete(threadId);
        ctx.stopped = true;
        const stamp = yield* makeEventStamp;
        yield* emitEvent(ctx, {
          type: "session.exited",
          ...stamp,
          provider: PUKU_CLI_PROVIDER,
          threadId,
          payload: { kind: "graceful" },
        });
      });

    const listSessions: ProviderAdapterShape<ProviderAdapterProcessError>["listSessions"] = () =>
      Effect.succeed(
        [...sessions.values()].map((ctx) => ({
          threadId: ctx.threadId,
          sessionId: ctx.sessionId,
          model: ctx.model,
          cwd: ctx.cwd,
          activeTurnId: ctx.activeTurnId,
          updatedAt: ctx.updatedAt,
        })),
      );

    const hasSession: ProviderAdapterShape<ProviderAdapterProcessError>["hasSession"] = (
      threadId,
    ) => Effect.succeed(sessions.has(threadId));

    const readThread: ProviderAdapterShape<ProviderAdapterProcessError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const turns: Array<ProviderThreadTurnSnapshot> = ctx.turns.map((turn) => ({
          id: turn.id,
          items: turn.items,
        }));
        const snapshot: ProviderThreadSnapshot = { threadId, turns };
        return snapshot;
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterProcessError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PUKU_CLI_PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const trimmed = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
        ctx.turns.length = 0;
        ctx.turns.push(...trimmed);
        const snapshot: ProviderThreadSnapshot = {
          threadId,
          turns: trimmed.map((turn) => ({ id: turn.id, items: turn.items })),
        };
        return snapshot;
      });

    const stopAll: ProviderAdapterShape<ProviderAdapterProcessError>["stopAll"] = () =>
      Effect.gen(function* () {
        const ids = [...sessions.keys()];
        for (const id of ids) {
          yield* stopSession(id);
        }
      });

    const streamEvents = PubSub.subscribe(pubsub);

    const adapter: ProviderAdapterShape<ProviderAdapterProcessError> = {
      provider: PUKU_CLI_PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported",
        supportsConversationRollback: true,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents,
    };

    return adapter;
  });
}

/**
 * Re-export a service-shape identifier for symmetry with the other
 * adapter modules (`CursorAdapter.ts`, `ClaudeAdapter.ts`). The adapter
 * itself is built as a closure by the driver; this type exists for
 * future migrations to Context.Service.
 */
export type PukuCliAdapterShape = ProviderAdapterShape<ProviderAdapterProcessError>;
