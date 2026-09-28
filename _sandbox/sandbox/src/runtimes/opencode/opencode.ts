import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    type Config as OpenCodeConfig,
    createOpencodeClient,
    createOpencodeServer,
    type Event as OpenCodeEvent,
    type OpencodeClient,
} from "@opencode-ai/sdk";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { idCatalog } from "../../agent/models/model-discovery.js";
import { engineBinary } from "../../engines/engine-resolve.js";
import { applyToStampedChild, SPAWN_STAMP_ENV } from "../../workload/workload-class.js";
import { type InputModality, OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { type CommandGuard, consultWith, vendorSubject } from "../../guard/command-guard.js";
import { cacheFile } from "../../store/open-document.js";
import { discoverXaiModels, isChatModel, SEED_XAI_MODELS } from "./xai-models.js";
import { z } from "zod";

// Shared OpenCode runtime: one warm `opencode serve` per container plus its client, used by turn adapters and the Grok
// auth routes. Two providers ride it credentialed oppositely: xai is OpenCode's own OAuth store; gemini's credential is
// the translator's (OpenAI-compatible endpoint), so `connected("gemini")` is never answered here.
export interface OpenCodeService {
    // Ensures the server is up and returns its client (lazy: the first turn or auth call boots it).
    readonly client: () => Promise<OpencodeClient>;
    // Shuts the server down; idempotent, and leaves the service able to boot a fresh one. The daemon never calls it:
    // only a caller that owns a short-lived service (e.g. tests) needs to release the process.
    readonly stop: () => Promise<void>;
    // This directory's session-event stream; scoped, since an unscoped subscription carries no session events (see
    // subscribeEvents).
    readonly events: (directory: string) => Promise<{ stream: AsyncIterable<OpenCodeEvent> }>;
    // Starts a permission watcher for this directory for the daemon's life (idempotent per directory); covers an
    // isolated conversation's worktree, which boot doesn't know about.
    readonly watch: (directory: string) => Promise<void>;
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
}

// How long `opencode serve` gets to print its listening line; longer than the SDK's 5s default since a cold spawn on a
// loaded host can miss it.
const BOOT_TIMEOUT_MS = 60_000;

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

// Turn gates keyed by OpenCode session id, the only key the detached daemon-wide watcher and a turn's rules share; an
// ask for an unregistered session gets the standing yes.
const sessionGates = new Map<string, CommandGuard>();

export const registerSessionGate = (sessionId: string, gate: CommandGuard): void => {
    sessionGates.set(sessionId, gate);
};

export const releaseSessionGate = (sessionId: string): void => {
    sessionGates.delete(sessionId);
};

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
// `permission.updated`, in two shapes. Both are answered through the per-session permissions route both still serve.
export interface PermissionAsk {
    readonly id: string;
    readonly sessionID: string;
    // Which permission: `bash`, `edit`, or a key this config does not declare.
    readonly kind: string;
    // What the classifier reads: the command where the ask names one, else its pattern or title.
    readonly program: string | undefined;
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
    pattern: z.union([z.string(), z.array(z.string())]).optional().catch(undefined),
    title: text,
    metadata: AskMetadataSchema,
});

/** The ask an event raises, or undefined for every other event. */
export const permissionAskOf = (event: { readonly type: string; readonly properties?: unknown }): PermissionAsk | undefined => {
    if (event.type === "permission.asked") {
        const asked = PermissionAskedSchema.safeParse(event.properties);
        return asked.success
            ? { id: asked.data.id, sessionID: asked.data.sessionID, kind: asked.data.permission, program: permissionProgram(asked.data.metadata, asked.data.patterns, undefined) }
            : undefined;
    }
    if (event.type !== "permission.updated") {
        return undefined;
    }
    const updated = PermissionUpdatedSchema.safeParse(event.properties);
    return updated.success
        ? { id: updated.data.id, sessionID: updated.data.sessionID, kind: updated.data.type, program: permissionProgram(updated.data.metadata, updated.data.pattern, updated.data.title) }
        : undefined;
};

// Answers a permission kind this config doesn't declare (future OpenCode keys default to `ask`) with a standing yes, so
// the worst case is one round-trip, not a wedged turn. `always`, not `once`: the pattern is allowed for the rest of the
// session.
const replyPermission = async (
    client: OpencodeClient,
    permission: { id: string; sessionID: string },
    directory: string,
    response: "once" | "always" | "reject",
): Promise<void> => {
    await client.postSessionIdPermissionsPermissionId({
        path: { id: permission.sessionID, permissionID: permission.id },
        query: { directory },
        body: { response },
    });
};

// Answers one permission: the owner's rulebook if this session has a gate, the standing yes otherwise. Refuse-only
// (`canPark: false`): the two-minute inactivity watchdog would kill a turn paused on a person, so a hold comes back as
// a refusal instead; an allowed command gets `once`, not `always`, since the next match could be one the rulebook would
// refuse.
const answerPermission = async (client: OpencodeClient, ask: PermissionAsk, directory: string): Promise<void> => {
    const gate = sessionGates.get(ask.sessionID);
    if (gate === undefined || !gate.enforcing || ask.program === undefined) {
        await replyPermission(client, ask, directory, "always");
        return;
    }
    // The no-op sink: with canPark false the gate never raises a card, so consultWith has nothing to push here.
    const outcome = await consultWith(gate, ask.program, vendorSubject(ask.kind), () => {});
    await replyPermission(client, ask, directory, outcome.allow ? "once" : "reject");
};

// How many times the stream may die in a row before the watcher gives up; the service never restarts a dead server
// either.
const STREAM_RETRIES = 3;
const STREAM_RETRY_MS = 5_000;

// The event stream is scoped to an exact directory match (not a prefix); subscribing without one still connects and
// heartbeats but carries no session events at all. One helper rather than inlining the query, since a subscription
// missing the scope fails silently.
const subscribeEvents = async (client: OpencodeClient, directory: string): ReturnType<OpencodeClient["event"]["subscribe"]> =>
    client.event.subscribe({ query: { directory } });

// Watches one directory's session events for the daemon's life, detached; answerPermission answers the permission asks
// raised on this stream. Per directory, not server-wide, since that's the only stream the server gives
// (subscribeEvents). `ended` runs once it gives up, so the next turn there opens a new watch rather than trusting a dead
// one with its permission asks.
const watchSessionEvents = (client: OpencodeClient, directory: string, ended: () => void): void => {
    void (async () => {
        for (let failures = 0; failures < STREAM_RETRIES; failures += 1) {
            try {
                const sse = await subscribeEvents(client, directory);
                for await (const event of sse.stream) {
                    failures = 0;
                    const ask = permissionAskOf(event);
                    if (ask !== undefined) {
                        // Detached: awaiting the reply here would stop reading the stream its own effects arrive on.
                        // allow(silent-catch): a failed reply just leaves the ask standing
                        void answerPermission(client, ask, directory).catch(() => {});
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
// since the Gemini catalog is built after this service in the composition order, read once lazily at boot.
export interface OpenCodeGeminiConfig {
    // The translator's base URL; its OpenAI-compatible surface is at ${baseUrl}/v1.
    readonly baseUrl: string;
    readonly token: string;
    // Each model's id and what it accepts as input, both as the translator publishes them (gemini-models.ts).
    readonly models: () => Promise<readonly { id: string; inputModalities: readonly InputModality[] }[]>;
}

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
    } = {},
): OpenCodeService => {
    const { gemini, workspaceRoot } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    const spawnServer = options.spawnServer ?? createOpencodeServer;
    let booting: Promise<OpencodeClient> | undefined;
    // Directories already being watched; streams are scoped to one exact directory, so this keeps one watcher per
    // directory.
    const watched = new Set<string>();
    // The server handle, kept only for stop(); every other caller wants the client instead.
    let serverHandle: { close(): void } | undefined;
    const opencodeDir = join(xdgDataHome, "opencode");
    const authPath = join(opencodeDir, "auth.json");
    // The last-known-good catalog, persisted next to auth.json so it survives daemon restarts.
    const modelsPath = join(opencodeDir, "xai-models.json");

    const boot = async (): Promise<OpencodeClient> => {
        // xAI stores request/response server-side by default; every known model opts out via per-model options, the
        // only seam OpenCode forwards. Config is fixed at spawn, so a self-healed model lacks the flag until the next
        // restart.
        const storeOptOut = [...new Set([...SEED_XAI_MODELS, ...(await modelStore.read())])];
        // Gemini rows read once here, since OpenCode fixes provider config at spawn.
        // allow(silent-catch): a failed catalog read costs Google its provider rather than Grok its runtime
        const geminiModels = gemini === undefined ? [] : await gemini.models().catch(() => []);
        const geminiProvider = geminiProviderConfig(gemini, geminiModels);
        // The last await: the environment is read after it, so a PATH another caller changed meanwhile is the one kept.
        const stored = await engineBinary("opencode");
        // The SDK spawns `opencode serve` with no hook and no pid, inside its first synchronous step: stamped across that
        // step, the child is found by the stamp and put in the runtime class before it has started anything.
        const stamp = randomUUID();
        // Pinned across the spawn call alone (pinnedAcross), never across the boot's wait for the listening line. PATH
        // puts an engine-store OpenCode copy in front so an Environment-card install is actually used, and is left as
        // it is without one.
        const starting = pinnedAcross(
            {
                XDG_DATA_HOME: xdgDataHome,
                PATH: stored === undefined ? undefined : `${dirname(stored)}:${process.env["PATH"] ?? ""}`,
                [SPAWN_STAMP_ENV]: stamp,
            },
            () =>
                spawnServer({
                    timeout: BOOT_TIMEOUT_MS,
                    ...(options.port === undefined ? {} : { port: options.port }),
                    // No provider key: xAI auth is OAuth, stored by OpenCode. Runs autonomously since the container is the
                    // isolation boundary; every permission is answered (ALLOW_EVERY_PERMISSION).
                    config: {
                        permission: ALLOW_EVERY_PERMISSION,
                        provider: {
                            xai: { models: Object.fromEntries(storeOptOut.map((id) => [id, { options: { store: false } }])) },
                            ...geminiProvider,
                        },
                    },
                }),
        );
        applyToStampedChild(stamp, { class: "agentRuntime", spawnDepth: 0 });
        const server = await starting;
        serverHandle = server;
        const client = createOpencodeClient({ baseUrl: server.url });
        // The permission watcher rides this boot; the workspace root is the one scope worth opening unasked, since an
        // isolated turn's worktree registers itself via watch().
        if (workspaceRoot !== undefined) {
            watched.add(workspaceRoot);
            watchSessionEvents(client, workspaceRoot, () => watched.delete(workspaceRoot));
        }
        return client;
    };

    // Single-flight: memoizes the in-flight boot, not just the finished client, so a caller arriving mid-spawn doesn't
    // start a rival server on the same fixed port. Cleared on rejection so a failed boot stays retryable.
    const ensure = (): Promise<OpencodeClient> => {
        booting ??= boot().catch((error: unknown) => {
            booting = undefined;
            throw error;
        });
        return booting;
    };

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
    // The xAI OAuth access token, only when unexpired; an expired one would 401 every discovery probe, so this skips
    // discovery and serves the persisted/seed catalog until OpenCode refreshes it.
    const usableXaiToken = async (): Promise<string | undefined> => {
        const entry = (await readAuth())["xai"];
        if (entry?.type !== "oauth" || typeof entry.access !== "string") {
            return undefined;
        }
        return entry.expires === undefined || Date.now() < entry.expires ? entry.access : undefined;
    };

    // xAI's catalog on the shared discovery ladder (agent/model-catalog.ts): live discovery, else the persisted file,
    // else the compile-time floor. Held by name as well as handed over, since boot needs the persisted ids without
    // asking xAI (a boot that waited on api.x.ai would hang whenever xAI is down).
    const modelStore = cacheFile<string[]>(modelsPath, {
        parse: (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : undefined),
        fallback: () => [],
    });
    const models = discoveredCatalog({
        // xAI's catalog rarely changes and each read is an api.x.ai round-trip.
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
        client: ensure,
        // Shuts the server down and leaves the service able to boot a fresh one; the daemon never calls it, only a
        // caller that owns a short-lived service does. Clears `booting` too, or a stopped service would keep handing
        // out a client pointed at a dead port.
        stop: async () => {
            serverHandle?.close();
            serverHandle = undefined;
            booting = undefined;
            watched.clear();
        },
        events: async (directory) => subscribeEvents(await ensure(), directory),
        watch: async (directory) => {
            if (watched.has(directory)) {
                return;
            }
            // Added before the await, so two turns starting in the same worktree in the same tick cannot both get past
            // the guard and open a stream each.
            watched.add(directory);
            watchSessionEvents(await ensure(), directory, () => watched.delete(directory));
        },
        connected: async (providerID) => {
            // Reads the persisted credential directly, not provider.list().connected, which OpenCode computes once at
            // server-init and never refreshes after a runtime auth.set().
            const entry = (await readAuth())[providerID];
            return entry?.type === "oauth" && typeof entry.access === "string";
        },
        sessionExists: async (sessionId, directory) => {
            const client = await ensure();
            return (await client.session.get({ path: { id: sessionId }, query: { directory } })).data !== undefined;
        },
        xaiModels: models.models,
        // Ids xAI named while rejecting something else, filtered/deduped here since a vendor's error can name anything
        // (including media endpoints); an empty result must not replace the known-good list.
        recordModels: async (ids) => {
            const valid = [...new Set(ids.filter(isChatModel))];
            if (valid.length > 0) {
                await models.record(valid);
            }
        },
        disconnect: async () => {
            // Both halves of the catalog, or a signed-out account keeps being offered for the rest of the TTL.
            models.forget();
            await rm(modelsPath, { force: true });
            await rm(authPath, { force: true });
        },
    };
};
