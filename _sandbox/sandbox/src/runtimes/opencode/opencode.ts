import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    type Config as OpenCodeConfig,
    createOpencodeClient,
    createOpencodeServer,
    type Event as OpenCodeEvent,
    type McpRemoteConfig,
    type OpencodeClient,
} from "@opencode-ai/sdk";
import { createOpencodeClient as createOpencodeReplyClient, type OpencodeClient as OpencodeReplyClient } from "@opencode-ai/sdk/v2/client";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { displayNameOf } from "@intentic/agent-context/tool-calls";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { idCatalog } from "../../agent/models/model-discovery.js";
import { engineBinary } from "../../engines/engine-resolve.js";
import { applyToStampedChild, SPAWN_STAMP_ENV } from "../../workload/workload-class.js";
import { type InputModality, OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { type CommandGuard, consultWith, type GuardOutcome, vendorSubject } from "../../guard/command-guard.js";
import { cacheFile } from "../../store/open-document.js";
import { discoverXaiModels, isChatModel, SEED_XAI_MODELS } from "./xai-models.js";
import type { OpenCodeMcpServer } from "./opencode-mcp.js";
import { z } from "zod";

// Shared OpenCode runtime: one warm `opencode serve` per container plus its client, used by turn adapters and the Grok
// auth routes. Two providers ride it credentialed oppositely: xai is OpenCode's own OAuth store; gemini's credential is
// the translator's (OpenAI-compatible endpoint), so `connected("gemini")` is never answered here.
export interface OpenCodeLease {
    readonly client: OpencodeClient;
    // Held through setup and cleanup, not just while a session has a permission judge; idempotent.
    readonly release: () => void;
}

export interface OpenCodeService {
    // Ensures the server is up and returns its client (lazy: the first turn or auth call boots it).
    readonly client: () => Promise<OpencodeClient>;
    // A turn's client, with Google registrations refreshed once the server is idle. Held until the turn's cleanup ends,
    // including helpers and turns with no permission judge, so a later acquisition cannot restart their server.
    readonly acquire: (model: { readonly providerID: string; readonly modelID?: string }) => Promise<OpenCodeLease>;
    // Shuts the server down; idempotent, and leaves the service able to boot a fresh one. The daemon never calls it:
    // only a caller that owns a short-lived service (e.g. tests) needs to release the process.
    readonly stop: () => Promise<void>;
    // This directory's session-event stream; scoped, since an unscoped subscription carries no session events (see
    // subscribeEvents).
    readonly events: (directory: string, signal?: AbortSignal) => Promise<{ stream: AsyncIterable<OpenCodeEvent> }>;
    // Starts a permission watcher for this directory for the current server's life (idempotent per directory); covers an
    // isolated conversation's worktree, which boot doesn't know about.
    readonly watch: (directory: string) => Promise<void>;
    // Mounts a turn's MCP servers on its directory's instance and returns their release, which the turn owes once it
    // ends. A server OpenCode could not reach is left out rather than failing the turn.
    readonly mount: (directory: string, servers: readonly OpenCodeMcpServer[]) => Promise<() => Promise<void>>;
    // Where a turn registers who answers its sessions' permission asks, which this server's watchers read.
    readonly judges: SessionJudges;
    // Whether a provider (e.g. "xai") is authenticated, read from OpenCode's persisted auth store on disk, not
    // provider.list().connected (computed once at server-init, never refreshed).
    readonly connected: (providerID: string) => Promise<boolean>;
    // Whether OpenCode still holds this session (resume pre-flight, as every other provider has); false on a lost
    // session, a rejection when the server could not be asked, since the probe's caller resumes rather than guessing.
    readonly sessionExists: (sessionId: string, directory: string) => Promise<boolean>;
    // xAI's model catalog plus a default id, always non-empty: live discovery with the OAuth token, else the last
    // persisted catalog, else the compile-time seed. Cached briefly, but never the seed, so a freshened token is
    // retried on the next read.
    readonly xaiModels: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
    // Persists the models xAI named valid in a "Did you mean" rejection as the last-known-good catalog; works even when
    // REST discovery rejects the token. No-op for an empty/media-only list.
    readonly recordModels: (ids: string[]) => Promise<void>;
    // Clears the auth store and persisted catalog directly (file-level); no provider-scoped SDK removal exists, and
    // this instance is Grok-only.
    readonly disconnect: (providerID: string) => Promise<void>;
    // Whether the running server's providers are routed the way the privacy shield now wants. Provider config is fixed
    // at spawn, so a server booted before the shield changed is restarted here once no turn is using it; false only
    // while a server booted unshielded is still busy and the shield now wants it shielded.
    readonly shielded: () => Promise<boolean>;
}

// Where OpenCode's xAI provider sends its requests unless told otherwise.
const XAI_UPSTREAM = "https://api.x.ai/v1";

// How long `opencode serve` gets to print its listening line; longer than the SDK's 5s default since a cold spawn on a
// loaded host can miss it.
const BOOT_TIMEOUT_MS = 60_000;

// The SDK's close() only signals the child. Do not race a replacement against its still-bound fixed port.
const STOP_TIMEOUT_MS = 10_000;
const waitForExit = async (pid: number, alive: (pid: number) => boolean): Promise<void> => {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (alive(pid)) {
        if (Date.now() >= deadline) {
            throw new Error("OpenCode's previous runtime has not finished stopping. Retry once it exits.");
        }
        await delay(20);
    }
};

// OpenCode's own off switches, pinned on the spawn so they hold in a bare dev run as well as in the image. Without them
// a cloned repo's opencode.json or .opencode/ configures this runtime: plugins, MCP servers, custom tools that replace a
// built-in by name (and so slip past ASK_ABOUT), and `share: "auto"`, which uploads every session to OpenCode's servers.
// Skipping project config also skips OpenCode's own read of the repo's AGENTS.md, which the daemon already composes
// into every turn (agent/prompt/workspace-memory.ts); `.agents/skills` and `.claude/skills` are not gated by it. The
// daemon's own MCP servers go on per turn through the server's API (`mount`), which no file in a repo reaches.
export const OPENCODE_LOCKDOWN_ENV = { OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" } as const;

// Every OpenCode permission key needs an explicit answer: an omitted one defaults to `ask`, which nothing on this
// container-isolated runtime can ever answer, silently stalling the turn.
// `bash` is a pattern map, not flat allow, so the owner's command rulebook can see interesting commands before they run
// without a round-trip on every call.
const ASK_ABOUT: Readonly<Record<string, "ask">> = {
    "*git push*": "ask",
    "*git reset*": "ask",
    "*git clean*": "ask",
    "*git branch*": "ask",
    "*git filter-branch*": "ask",
    "*rm *": "ask",
    "*.env*": "ask",
    "*.ssh/*": "ask",
    "*id_rsa*": "ask",
    "*id_ed25519*": "ask",
    "*.npmrc*": "ask",
    "*credentials*": "ask",
    "*publish*": "ask",
    "*release create*": "ask",
    "*docker push*": "ask",
    "*twine upload*": "ask",
    "*curl *": "ask",
    "*wget *": "ask",
};

const ALLOW_EVERY_PERMISSION: Required<NonNullable<OpenCodeConfig["permission"]>> = {
    edit: "allow",
    // The one kind with a pattern map: allow by default, ask about the shapes the rulebook might care about.
    bash: { "*": "allow", ...ASK_ABOUT },
    webfetch: "allow",
    doom_loop: "allow",
    external_directory: "allow",
};

// What answers one session's permission asks: the turn's rulebook gate, where the cards it raises go (the turn's own
// stream, in order with its events), and the turn watchdog's hold, taken while an ask waits on the daemon's answer so a
// card open on a person is not read as a stalled turn.
export interface SessionJudge {
    readonly gate: CommandGuard;
    readonly push: (event: AgentEvent) => void;
    readonly hold: () => () => void;
}

// Who answers each session's asks while its turn runs, keyed by OpenCode session id, the only key the detached watcher
// and a turn's rules share; an ask for a session with none gets the standing yes.
export interface SessionJudges {
    readonly register: (sessionId: string, judge: SessionJudge) => void;
    readonly release: (sessionId: string) => void;
}

// A field read tolerantly: a value of another type reads as absent rather than failing the whole ask, which would then
// go unanswered.
const text = z.string().optional().catch(undefined);

// What an ask's metadata may name as the command it is about; OpenCode's Permission declares no command field, so the
// spellings are tried in order and every other key is left behind.
const AskMetadataSchema = z.object({ command: text, cmd: text, script: text, input: text }).optional().catch(undefined);
type AskMetadata = z.infer<typeof AskMetadataSchema>;

// Text the classifier can read for this permission: metadata, then pattern, then title. A miss defaults to allow, not
// refuse.
const permissionProgram = (metadata: AskMetadata, pattern: string | readonly string[] | undefined, title: string | undefined): string | undefined => {
    const named = [metadata?.command, metadata?.cmd, metadata?.script, metadata?.input].find((value) => value !== undefined && value.trim() !== "");
    if (named !== undefined) {
        return named;
    }
    const patterns = typeof pattern === "string" ? pattern : pattern?.join(" ");
    if (patterns !== undefined && patterns.trim() !== "") {
        return patterns;
    }
    return title === undefined || title.trim() === "" ? undefined : title;
};

// One ask, whichever event carried it: OpenCode 1.18 asks with `permission.asked`, earlier releases with
// `permission.updated`, in two shapes, each answered on the route its own release serves.
export interface PermissionAsk {
    readonly id: string;
    readonly sessionID: string;
    // Which permission: `bash`, `edit`, or a key this config does not declare.
    readonly kind: string;
    // What the classifier reads: the command where the ask names one, else its pattern or title.
    readonly program: string | undefined;
    // An ask in the older shape, answered on the per-session route, which carries no reason back to the model.
    readonly legacy: boolean;
}

// Both shapes read at the stream, never trusted as typed: the v1 SDK's event union names only the older one.
const PermissionAskedSchema = z.object({
    id: z.string(),
    sessionID: z.string(),
    permission: z.string(),
    patterns: z.array(z.string()).optional().catch(undefined),
    metadata: AskMetadataSchema,
});
const PermissionUpdatedSchema = z.object({
    id: z.string(),
    sessionID: z.string(),
    type: z.string().catch(""),
    pattern: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .catch(undefined),
    title: text,
    metadata: AskMetadataSchema,
});

/** The ask an event raises, or undefined for every other event. */
export const permissionAskOf = (event: { readonly type: string; readonly properties?: unknown }): PermissionAsk | undefined => {
    if (event.type === "permission.asked") {
        const asked = PermissionAskedSchema.safeParse(event.properties);
        return asked.success
            ? {
                  id: asked.data.id,
                  sessionID: asked.data.sessionID,
                  kind: asked.data.permission,
                  program: permissionProgram(asked.data.metadata, asked.data.patterns, undefined),
                  legacy: false,
              }
            : undefined;
    }
    if (event.type !== "permission.updated") {
        return undefined;
    }
    const updated = PermissionUpdatedSchema.safeParse(event.properties);
    return updated.success
        ? {
              id: updated.data.id,
              sessionID: updated.data.sessionID,
              kind: updated.data.type,
              program: permissionProgram(updated.data.metadata, updated.data.pattern, updated.data.title),
              legacy: true,
          }
        : undefined;
};

// One answer as OpenCode takes it. A refusal carries its reason, which OpenCode hands the model as the call's feedback
// and keeps the turn going; a bare `reject` would stop the whole session's loop instead.
type PermissionReply = { readonly reply: "once" | "always" } | { readonly reply: "reject"; readonly message: string };

const replyPermission = async (replies: OpencodeReplyClient, ask: PermissionAsk, directory: string, answer: PermissionReply): Promise<void> => {
    if (ask.legacy) {
        await replies.permission.respond({ sessionID: ask.sessionID, permissionID: ask.id, directory, response: answer.reply });
        return;
    }
    await replies.permission.reply({ requestID: ask.id, directory, ...answer });
};

// Fail closed: a consult that threw has no verdict to stand on, and an unanswered ask would stall the turn instead.
const CONSULT_FAILED =
    "This could not be checked against your owner's safety policy, so it was refused. " +
    "Do not retry: carry on with what you can do without it, and say plainly what you left undone.";

// Answers one permission: the owner's rulebook if this session has a judge, the standing yes otherwise, which is
// `always` so an undeclared kind (future OpenCode keys default to `ask`) costs one round trip rather than one per call.
// A hold parks on a card like Codex's: the turn's watchdog is held for the whole consult, and the card's frames reach
// the turn's stream through the judge. An allowed command gets `once`, not `always`, since the next match could be one
// the rulebook would refuse; the owner's own Always is remembered in their policy, which stays the authority.
const answerPermission = async (
    replies: OpencodeReplyClient,
    judge: SessionJudge | undefined,
    ask: PermissionAsk,
    directory: string,
): Promise<void> => {
    if (judge === undefined || !judge.gate.enforcing || ask.program === undefined) {
        await replyPermission(replies, ask, directory, { reply: "always" });
        return;
    }
    const release = judge.hold();
    let outcome: GuardOutcome;
    try {
        outcome = await consultWith(judge.gate, ask.program, vendorSubject(displayNameOf(ask.kind)), judge.push);
    } catch {
        // allow(silent-catch): answered below as a refusal naming the failure, the only verdict left to give
        outcome = { allow: false, reason: CONSULT_FAILED };
    } finally {
        release();
    }
    await replyPermission(replies, ask, directory, outcome.allow ? { reply: "once" } : { reply: "reject", message: outcome.reason });
};

// How many times the stream may die in a row before the watcher gives up; a dead server is booted afresh by the next
// turn (ensure), which opens its own watch.
const STREAM_RETRIES = 3;
const STREAM_RETRY_MS = 5_000;

// The event stream is scoped to an exact directory match (not a prefix); subscribing without one still connects and
// heartbeats but carries no session events at all. One helper rather than inlining the query, since a subscription
// missing the scope fails silently.
// The SDK's stream retries a lost connection for ever by default, so a server that died (an OOM kill) would leave every
// reader parked on a stream that never ends; bounded, the stream ends and its reader sees the server gone.
const SSE_RETRY_ATTEMPTS = 3;
const SSE_RETRY_DELAY_MS = 1_000;

// Both SDKs' streams end on abort by cancelling their body reader, and drop the promise that cancel returns. Fetch hears
// the same abort first and errors the body, so that promise rejects with the abort and nothing handles it: every stopped
// stream was a stray rejection, which under bun test fails whichever test runs next. So the abort reaches fetch only
// while it connects; once a response is in, the SDK's own cancel closes the live body, which ends the request.
export const abortWhileConnecting = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const connecting = new AbortController();
    const abort = (): void => connecting.abort(request.signal.reason);
    if (request.signal.aborted) {
        abort();
    } else {
        request.signal.addEventListener("abort", abort, { once: true });
    }
    try {
        return await fetch(new Request(request, { signal: connecting.signal }));
    } finally {
        request.signal.removeEventListener("abort", abort);
    }
};

// Subscribed through the current API's client: the v1 client's stream calls the global fetch itself, so only this one can
// be handed abortWhileConnecting. The events are the same server's JSON whichever client reads them.
export const subscribeEvents = async (
    replies: OpencodeReplyClient,
    directory: string,
    signal: AbortSignal | null = null,
): Promise<{ readonly stream: AsyncIterable<OpenCodeEvent> }> => {
    const { stream } = await replies.event.subscribe(
        { directory },
        {
            signal,
            // bun-types' `fetch` carries `preconnect`, which a request wrapper has no use for.
            fetch: abortWhileConnecting as typeof fetch,
            sseMaxRetryAttempts: SSE_RETRY_ATTEMPTS,
            sseDefaultRetryDelay: SSE_RETRY_DELAY_MS,
        },
    );
    // SAFETY: one server writes this stream whichever SDK parses it; its readers are written against the v1 event union.
    return { stream: stream as AsyncIterable<OpenCodeEvent> };
};

// Whether a process still exists; signal 0 checks without sending anything, and EPERM still means it is there.
export const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

// The server's two clients: the one every call rides, and the current API's, which alone can answer a permission with
// the reason the model should hear, and whose event stream takes the fetch a stream needs to stop quietly.
interface OpenCodeClients {
    readonly client: OpencodeClient;
    readonly replies: OpencodeReplyClient;
    // The judge of a session's asks, if its turn registered one.
    readonly judgeOf: (sessionId: string) => SessionJudge | undefined;
}

// Watches one directory's session events for the daemon's life, detached; answerPermission answers the permission asks
// raised on this stream. Per directory, not server-wide, since that's the only stream the server gives
// (subscribeEvents). `ended` runs once it gives up, so the next turn there opens a new watch rather than trusting a dead
// one with its permission asks.
const watchSessionEvents = ({ replies, judgeOf }: OpenCodeClients, directory: string, signal: AbortSignal, ended: () => void): void => {
    void (async () => {
        for (let failures = 0; failures < STREAM_RETRIES && !signal.aborted; failures += 1) {
            try {
                const sse = await subscribeEvents(replies, directory, signal);
                for await (const event of sse.stream) {
                    if (signal.aborted) {
                        return;
                    }
                    failures = 0;
                    const ask = permissionAskOf(event);
                    if (ask !== undefined) {
                        // Detached: awaiting the reply here would stop reading the stream its own effects arrive on.
                        // allow(silent-catch): a failed reply just leaves the ask standing
                        void answerPermission(replies, judgeOf(ask.sessionID), ask, directory).catch(() => {});
                    }
                }
            } catch {
                // allow(silent-catch): the stream ended or never opened, which is counted and retried below
            }
            await new Promise((resolve) => {
                setTimeout(resolve, STREAM_RETRY_MS).unref();
            });
        }
    })().finally(ended);
};

// What a Gemini turn needs declared at server spawn; absent means no Gemini provider registered. `models` is a thunk
// since the Gemini catalog is built after this service in the composition order, read lazily at boot and acquisition.
export interface OpenCodeGeminiConfig {
    // The translator's base URL; its OpenAI-compatible surface is at ${baseUrl}/v1.
    readonly baseUrl: string;
    readonly token: string;
    // Each model's id and what it accepts as input, both as the translator publishes them (gemini-models.ts).
    readonly models: () => Promise<readonly { id: string; inputModalities: readonly InputModality[] }[]>;
}

type GeminiModels = Awaited<ReturnType<OpenCodeGeminiConfig["models"]>>;

// A refresh must not park every acquisition behind an unresponsive translator, before a turn has a watchdog.
const CATALOG_TIMEOUT_MS = 5_000;
const readGeminiModels = async (gemini: OpenCodeGeminiConfig | undefined): Promise<GeminiModels | undefined> => {
    if (gemini === undefined) {
        return undefined;
    }
    const expired = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => expired.resolve(undefined), CATALOG_TIMEOUT_MS).unref();
    try {
        return await Promise.race([gemini.models(), expired.promise]);
    } catch {
        // allow(silent-catch): failed discovery retains the working registration or lets Grok boot without Google
        return undefined;
    } finally {
        clearTimeout(timer);
    }
};

// Provider registration depends on membership and capabilities, not the discovery order or the catalog's default.
const geminiModelSignature = (models: GeminiModels): string =>
    JSON.stringify([...models].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, inputModalities }) => [id, [...inputModalities].sort()]));

// What a failure sentence calls the backend: one opencode serve drives both providers, so the Gemini turn is the Grok
// adapter with a different providerID. Keyed off OpenCode's provider id, since that's what the turn actually carries.
export const openCodeBackendLabel = (providerID: string): string => (providerID === OPENCODE_GEMINI_PROVIDER ? "Google" : "Grok");

// Declares Gemini as an OpenAI-compatible endpoint; OpenCode has no models.dev row for it, so an omitted capability
// defaults to false and strips images from the request. Modalities come off the translator's own published list; no
// models means no provider registered at all.
export const geminiProviderConfig = (
    gemini: OpenCodeGeminiConfig | undefined,
    models: readonly { id: string; inputModalities: readonly InputModality[] }[],
): NonNullable<OpenCodeConfig["provider"]> =>
    gemini === undefined || models.length === 0
        ? {}
        : {
              [OPENCODE_GEMINI_PROVIDER]: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "Gemini",
                  options: { baseURL: `${gemini.baseUrl.replace(/\/$/, "")}/v1`, apiKey: gemini.token },
                  models: Object.fromEntries(
                      models.map((model) => [
                          model.id,
                          {
                              // Two flags gate an image's two entry points: `attachment` for a tool's image output,
                              // `modalities.input` for a prompt file part; output is always text since image generators
                              // are filtered upstream (isChatModel).
                              attachment: model.inputModalities.some((modality) => modality !== "text"),
                              modalities: { input: [...model.inputModalities], output: ["text" as InputModality] },
                          },
                      ]),
                  ),
              },
          };

// createOpencodeServer inherits process.env with no override seam. It copies the environment and spawns `opencode serve`
// in its synchronous prefix (before its first await), so `env` is pinned only across that call and every key is put
// back as soon as it returns: a child the daemon spawns while the server boots (Claude, Codex, git) never inherits it.
// A key given as undefined is left as it is.
export const pinnedAcross = <T>(env: Readonly<Record<string, string | undefined>>, spawn: () => T): T => {
    const pins = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
    const previous = pins.map(([key]) => [key, process.env[key]] as const);
    for (const [key, value] of pins) {
        process.env[key] = value;
    }
    try {
        return spawn();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
};

// The MCP servers turns hold on each directory's instance. OpenCode keeps one client per server name there, and two turns
// of one conversation can hold the same name at once, so each name's client carries its newest holder's config (that
// turn's bearer) and is disconnected once the last holder lets go. Changes to one name run in order, so the client ends
// on the newest holder whichever call lands first.
const mcpHolds = (client: () => Promise<OpencodeClient>) => {
    const holders = new Map<string, { readonly id: symbol; readonly config: McpRemoteConfig }[]>();
    // Which holder each name's client was last set to; absent once disconnected.
    const applied = new Map<string, symbol>();
    const settling = new Map<string, Promise<void>>();
    const keyOf = (directory: string, name: string): string => `${directory}\u0000${name}`;

    // Brings one name's client in line with its newest holder, after whatever change to it is already under way.
    const settle = (opencode: OpencodeClient, directory: string, name: string): Promise<void> => {
        const key = keyOf(directory, name);
        const next = (settling.get(key) ?? Promise.resolve())
            .then(async () => {
                const newest = holders.get(key)?.at(-1);
                if (applied.get(key) === newest?.id) {
                    return;
                }
                if (newest === undefined) {
                    applied.delete(key);
                    await opencode.mcp.disconnect({ path: { name }, query: { directory } });
                    return;
                }
                applied.set(key, newest.id);
                await opencode.mcp.add({ body: { name, config: newest.config }, query: { directory } });
            })
            // allow(silent-catch): a server OpenCode could not mount is a tool the turn goes without, not a failed turn
            .catch(() => {});
        settling.set(key, next);
        void next.then(() => {
            if (settling.get(key) === next) {
                settling.delete(key);
            }
        });
        return next;
    };

    return {
        mount: async (directory: string, servers: readonly OpenCodeMcpServer[]): Promise<() => Promise<void>> => {
            if (servers.length === 0) {
                return async () => {};
            }
            const opencode = await client();
            const id = Symbol("mount");
            for (const server of servers) {
                const key = keyOf(directory, server.name);
                holders.set(key, [...(holders.get(key) ?? []), { id, config: server.config }]);
            }
            await Promise.all(servers.map((server) => settle(opencode, directory, server.name)));
            let released = false;
            return async () => {
                if (released) {
                    return;
                }
                released = true;
                for (const server of servers) {
                    const key = keyOf(directory, server.name);
                    const left = (holders.get(key) ?? []).filter((holder) => holder.id !== id);
                    if (left.length === 0) {
                        holders.delete(key);
                    } else {
                        holders.set(key, left);
                    }
                }
                await Promise.all(servers.map((server) => settle(opencode, directory, server.name)));
            };
        },
        // A stopped server took every client with it.
        forget: (): void => {
            holders.clear();
            applied.clear();
            settling.clear();
        },
    };
};

// Each watcher belongs to one boot. Aborting that boot's streams keeps their retries off a replacement server at the
// same port, and the identity check keeps their eventual completion from erasing its new watcher for the same directory.
const directoryWatchers = () => {
    let stop = new AbortController();
    const watched = new Map<string, symbol>();
    return {
        watch: (clients: OpenCodeClients, directory: string): void => {
            if (watched.has(directory)) {
                return;
            }
            const id = Symbol(directory);
            watched.set(directory, id);
            watchSessionEvents(clients, directory, stop.signal, () => {
                if (watched.get(directory) === id) {
                    watched.delete(directory);
                }
            });
        },
        forget: (): void => {
            stop.abort();
            stop = new AbortController();
            watched.clear();
        },
    };
};

// xAI's auth and discovery ladder live independently of the served process. Boot reads only persisted ids, without a
// round trip to api.x.ai; turn-time model discovery uses the unexpired token and falls back to persistence/the seed.
const createXaiCatalog = (opencodeDir: string, fetchImpl: typeof fetch) => {
    const authPath = join(opencodeDir, "auth.json");
    const modelsPath = join(opencodeDir, "xai-models.json");
    // OpenCode's persisted auth store, each provider keyed at the top level: { xai: { type: "oauth", access, refresh,
    // expires } } (expires is a ms epoch). {} when absent/unreadable.
    const readAuth = async (): Promise<Record<string, { type?: string; access?: string; expires?: number } | undefined>> => {
        try {
            return JSON.parse(await readFile(authPath, "utf8")) as Record<string, { type?: string; access?: string; expires?: number } | undefined>;
        } catch {
            // allow(silent-catch): an absent or unreadable auth store holds no connected provider
            return {};
        }
    };
    const usableXaiToken = async (): Promise<string | undefined> => {
        const entry = (await readAuth())["xai"];
        if (entry?.type !== "oauth" || typeof entry.access !== "string") {
            return undefined;
        }
        return entry.expires === undefined || Date.now() < entry.expires ? entry.access : undefined;
    };
    const modelStore = cacheFile<string[]>(modelsPath, {
        parse: (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : undefined),
        fallback: () => [],
    });
    const models = discoveredCatalog({
        ttlMs: 60_000,
        discover: async () => {
            const token = await usableXaiToken();
            return token === undefined ? [] : await discoverXaiModels(token, fetchImpl);
        },
        idOf: (id) => id,
        store: modelStore,
        toStored: (ids) => [...ids],
        seed: SEED_XAI_MODELS,
        fromLive: idCatalog,
        fromStored: idCatalog,
    });
    return {
        persisted: modelStore.read,
        models: models.models,
        connected: async (providerID: string): Promise<boolean> => {
            // Read directly, not provider.list().connected, which OpenCode never refreshes after runtime auth.set().
            const entry = (await readAuth())[providerID];
            return entry?.type === "oauth" && typeof entry.access === "string";
        },
        record: async (ids: string[]): Promise<void> => {
            // A vendor's suggestions can name media endpoints; an empty result must not replace the known-good list.
            const valid = [...new Set(ids.filter(isChatModel))];
            if (valid.length > 0) {
                await models.record(valid);
            }
        },
        disconnect: async (): Promise<void> => {
            models.forget();
            await rm(modelsPath, { force: true });
            await rm(authPath, { force: true });
        },
    };
};

// Options bag rather than more positionals, so a production option never has to land after the test's fetch-injection
// seam.
export const createOpenCodeService = (
    xdgDataHome: string,
    options: {
        readonly gemini?: OpenCodeGeminiConfig;
        readonly fetchImpl?: typeof fetch;
        readonly workspaceRoot?: string;
        // Which port the server listens on; absent uses the SDK default (one per machine). Nameable so a second server
        // (e.g. the conformance tier, whose provider config is fixed at spawn) can run beside the daemon's.
        readonly port?: number;
        // What starts `opencode serve`; the SDK's own unless a test watches the environment the spawn sees.
        readonly spawnServer?: typeof createOpencodeServer;
        // Whether the served process still runs; the real process table unless a test stands in for it.
        readonly alive?: (pid: number) => boolean;
        // The privacy shield's gateway base URL for a provider's requests, or undefined while the shield is off.
        readonly route?: (provider: "grok" | "gemini", upstream: string) => Promise<string | undefined>;
    } = {},
): OpenCodeService => {
    const { gemini, workspaceRoot, route, fetchImpl = fetch, spawnServer = createOpencodeServer, alive = processAlive } = options;
    const xai = createXaiCatalog(join(xdgDataHome, "opencode"), fetchImpl);
    // Whether the server now running was booted behind the gateway; undefined before any boot.
    let bootedShielded: boolean | undefined;
    let bootedGeminiModels: GeminiModels = [];
    // Acquisitions run in order; leases protect setup, helpers and ungated turns as well as judged sessions.
    let acquisitions = Promise.resolve();
    let activeTurns = 0;
    let booting: Promise<OpenCodeClients> | undefined;
    // The served process, once found by its spawn stamp; undefined where it cannot be found (not Linux).
    let serverPid: number | undefined;
    let serverHandle: { close(): void } | undefined;
    const watchers = directoryWatchers();
    const sessionJudges = new Map<string, SessionJudge>();
    const judgeOf = (sessionId: string): SessionJudge | undefined => sessionJudges.get(sessionId);

    const boot = async (knownGeminiModels?: GeminiModels): Promise<OpenCodeClients> => {
        // xAI stores request/response server-side by default; every known model opts out via per-model options, the
        // only seam OpenCode forwards. Config is fixed at spawn, so a self-healed model lacks the flag until the next
        // restart.
        const storeOptOut = [...new Set([...SEED_XAI_MODELS, ...(await xai.persisted())])];
        // An acquisition hands over the exact catalog it compared, so a second discovery cannot race the refresh.
        const geminiModels = knownGeminiModels ?? (await readGeminiModels(gemini)) ?? [];
        // Behind the privacy shield, both providers send to its gateway, which forwards where they would have gone.
        const xaiGateway = await route?.("grok", XAI_UPSTREAM);
        const geminiGateway = gemini === undefined ? undefined : await route?.("gemini", gemini.baseUrl);
        bootedShielded = xaiGateway !== undefined || geminiGateway !== undefined;
        const geminiProvider = geminiProviderConfig(
            gemini === undefined || geminiGateway === undefined ? gemini : { ...gemini, baseUrl: geminiGateway },
            geminiModels,
        );
        // The last await: the environment is read after it, so a PATH another caller changed meanwhile is the one kept.
        const stored = await engineBinary("opencode");
        // The SDK spawns `opencode serve` with no hook and no pid, inside its first synchronous step: stamped across that
        // step, the child is found by the stamp and put in the runtime class before it has started anything.
        const stamp = randomUUID();
        const starting = pinnedAcross(
            {
                ...OPENCODE_LOCKDOWN_ENV,
                XDG_DATA_HOME: xdgDataHome,
                PATH: stored === undefined ? undefined : `${dirname(stored)}:${process.env["PATH"] ?? ""}`,
                [SPAWN_STAMP_ENV]: stamp,
            },
            () =>
                spawnServer({
                    timeout: BOOT_TIMEOUT_MS,
                    ...(options.port === undefined ? {} : { port: options.port }),
                    // Inline config wins over a project's config, even where project config is read. xAI's OAuth
                    // credential remains in OpenCode's auth store; every permission has an explicit answer.
                    config: {
                        share: "disabled",
                        permission: ALLOW_EVERY_PERMISSION,
                        provider: {
                            xai: {
                                ...(xaiGateway === undefined ? {} : { options: { baseURL: xaiGateway } }),
                                models: Object.fromEntries(storeOptOut.map((id) => [id, { options: { store: false } }])),
                            },
                            ...geminiProvider,
                        },
                    },
                }),
        );
        // Started now, while the child is young, and read once the server is up; it never rejects.
        const classed = applyToStampedChild(stamp, { class: "agentRuntime", spawnDepth: 0 });
        const server = await starting;
        serverPid = await classed;
        serverHandle = server;
        const clients = {
            client: createOpencodeClient({ baseUrl: server.url }),
            replies: createOpencodeReplyClient({ baseUrl: server.url }),
            judgeOf,
        };
        bootedGeminiModels = geminiModels;
        if (workspaceRoot !== undefined) {
            watchers.watch(clients, workspaceRoot);
        }
        return clients;
    };

    let stoppingPid: number | undefined;
    let stopping: Promise<void> | undefined;
    // A timed-out stop keeps its pid: a later acquisition retries the exit wait, never spawns onto an occupied port.
    const finishStopping = (): Promise<void> => {
        if (stoppingPid === undefined) {
            return Promise.resolve();
        }
        const pid = stoppingPid;
        stopping ??= waitForExit(pid, alive)
            .then(() => {
                stoppingPid = undefined;
            })
            .finally(() => {
                stopping = undefined;
            });
        return stopping;
    };
    // Memoize the in-flight boot as well as the finished client. A failed boot stays retryable; a dead process loses its
    // cached client so the next turn boots a fresh server rather than fetching a dead port.
    const ensure = async (geminiModels?: GeminiModels): Promise<OpenCodeClients> => {
        await finishStopping();
        if (booting !== undefined && serverPid !== undefined && !alive(serverPid)) {
            forget();
        }
        booting ??= retryableBoot(boot(geminiModels));
        return booting;
    };
    const mounts = mcpHolds(async () => (await ensure()).client);
    // Everything that belonged to the last server: its client, its watchers and its mounted MCP clients.
    function forget(): void {
        booting = undefined;
        serverPid = undefined;
        bootedShielded = undefined;
        bootedGeminiModels = [];
        watchers.forget();
        mounts.forget();
    }
    const closeServer = (): Promise<void> => {
        serverHandle?.close();
        serverHandle = undefined;
        stoppingPid ??= serverPid;
        forget();
        return finishStopping();
    };
    const retryableBoot = async (attempt: Promise<OpenCodeClients>): Promise<OpenCodeClients> => {
        try {
            return await attempt;
        } catch (error) {
            booting = undefined;
            throw error;
        }
    };
    const restart = (models: GeminiModels): Promise<OpenCodeClients> => {
        // Publish the replacement boot before yielding, so raw client probes also wait for this exact catalog.
        booting = retryableBoot(closeServer().then(() => boot(models)));
        return booting;
    };
    const take = async (model: Parameters<OpenCodeService["acquire"]>[0]): Promise<OpenCodeLease> => {
        // Include this acquisition's asynchronous setup in its lifetime, including privacy-shield checks racing it.
        activeTurns += 1;
        try {
            // Only a Google acquisition reads Google's catalog: a Grok turn never waits on the translator, and a newly
            // listed Google model is registered by the next Google turn that finds the runtime idle.
            const latest = model.providerID === OPENCODE_GEMINI_PROVIDER ? await readGeminiModels(gemini) : undefined;
            // A failed first read already has its answer: do not wait on discovery a second time during boot.
            let clients = await ensure(model.providerID === OPENCODE_GEMINI_PROVIDER ? (latest ?? []) : undefined);
            if (latest !== undefined && latest.length > 0 && geminiModelSignature(latest) !== geminiModelSignature(bootedGeminiModels)) {
                if (activeTurns === 1 && sessionJudges.size === 0) {
                    clients = await restart(latest);
                } else if (model.modelID !== undefined && !bootedGeminiModels.some((row) => row.id === model.modelID)) {
                    throw new Error(
                        `Google's model catalog has refreshed, but its shared runtime is still running other turns. Send again once they finish to use ${model.modelID}.`,
                    );
                }
            }
            let released = false;
            return {
                client: clients.client,
                release: () => {
                    if (!released) {
                        released = true;
                        activeTurns -= 1;
                    }
                },
            };
        } catch (error) {
            activeTurns -= 1;
            throw error;
        }
    };
    const acquire: OpenCodeService["acquire"] = (model) => {
        const next = acquisitions.then(() => take(model));
        // A refused acquisition must not poison the next turn's place in the queue.
        acquisitions = next.then(
            () => {},
            () => {},
        );
        return next;
    };

    return {
        client: async () => (await ensure()).client,
        acquire,
        stop: async () => closeServer(),
        events: async (directory, signal) => subscribeEvents((await ensure()).replies, directory, signal),
        watch: async (directory) => watchers.watch(await ensure(), directory),
        mount: mounts.mount,
        judges: {
            register: (sessionId, judge) => {
                sessionJudges.set(sessionId, judge);
            },
            release: (sessionId) => {
                sessionJudges.delete(sessionId);
            },
        },
        connected: xai.connected,
        sessionExists: async (sessionId, directory) => {
            const { client } = await ensure();
            return (await client.session.get({ path: { id: sessionId }, query: { directory } })).data !== undefined;
        },
        xaiModels: xai.models,
        recordModels: xai.record,
        disconnect: xai.disconnect,
        shielded: async () => {
            const wanted = (await route?.("grok", XAI_UPSTREAM)) !== undefined;
            if (booting === undefined || bootedShielded === undefined || bootedShielded === wanted) {
                return true;
            }
            // Idle: the next turn boots routed the way the shield now wants. Judges cover legacy callers too.
            if (activeTurns === 0 && sessionJudges.size === 0) {
                await closeServer();
                return true;
            }
            // Busy and still routed through the gateway the shield no longer needs: a plain relay, harmless.
            return !wanted;
        },
    };
};
