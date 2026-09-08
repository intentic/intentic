import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    type Config as OpenCodeConfig,
    createOpencodeClient,
    createOpencodeServer,
    type Event as OpenCodeEvent,
    type OpencodeClient,
    type Permission as OpenCodePermission,
} from "@opencode-ai/sdk";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { idCatalog } from "../../agent/models/model-discovery.js";
import { engineBinary } from "../../engines/engine-resolve.js";
import type { InputModality } from "../gemini/gemini-models.js";
import { type CommandGate, consultWith, vendorSubject } from "../../guard/command-gate.js";
import { jsonFile } from "../../store/json-file.js";
import { discoverXaiModels, isChatModel, SEED_XAI_MODELS } from "./grok-models.js";

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
    // session or unreachable server, so the next turn starts fresh instead of resending into a dead id forever.
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

// "rebuild" must stay in this sentence: the UI matches on that word to route to the Environment card. `backend` names
// the product the user picked, not the runtime that's missing (see openCodeBackendLabel).
export const openCodeBinaryMissing = (backend: string): string =>
    `This sandbox's image doesn't include the OpenCode CLI yet: rebuild it from the Environment card in Sandbox ▸ Environment to run ${backend} here.`;

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
const sessionGates = new Map<string, CommandGate>();

export const registerSessionGate = (sessionId: string, gate: CommandGate): void => {
    sessionGates.set(sessionId, gate);
};

export const releaseSessionGate = (sessionId: string): void => {
    sessionGates.delete(sessionId);
};

// Text the classifier can read for this permission; OpenCode's Permission has no declared command field, so
// metadata/pattern/title are read tolerantly in order. A miss defaults to allow, not refuse.
const permissionProgram = (permission: OpenCodePermission): string | undefined => {
    const metadata = permission.metadata as Record<string, unknown> | undefined;
    for (const key of ["command", "cmd", "script", "input"]) {
        const value = metadata?.[key];
        if (typeof value === "string" && value.trim() !== "") {
            return value;
        }
    }
    const pattern = Array.isArray(permission.pattern) ? permission.pattern.join(" ") : permission.pattern;
    if (typeof pattern === "string" && pattern.trim() !== "") {
        return pattern;
    }
    return permission.title.trim() === "" ? undefined : permission.title;
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
const answerPermission = async (client: OpencodeClient, permission: OpenCodePermission, directory: string): Promise<void> => {
    const gate = sessionGates.get(permission.sessionID);
    if (gate === undefined || !gate.enforcing) {
        await replyPermission(client, permission, directory, "always");
        return;
    }
    const program = permissionProgram(permission);
    if (program === undefined) {
        await replyPermission(client, permission, directory, "always");
        return;
    }
    // The no-op sink: with canPark false the gate never raises a card, so consultWith has nothing to push here.
    const outcome = await consultWith(gate, program, vendorSubject(permission.type), () => {});
    await replyPermission(client, permission, directory, outcome.allow ? "once" : "reject");
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
// (subscribeEvents).
const watchSessionEvents = (client: OpencodeClient, directory: string): void => {
    void (async () => {
        for (let failures = 0; failures < STREAM_RETRIES; failures += 1) {
            try {
                const sse = await subscribeEvents(client, directory);
                for await (const event of sse.stream) {
                    failures = 0;
                    if (event.type === "permission.updated") {
                        // Detached: awaiting the reply here would stop reading the stream its own effects arrive on; a
                        // failed reply just leaves the ask standing.
                        void answerPermission(client, event.properties, directory).catch(() => {});
                    }
                }
            } catch {
                // The stream ended or never opened, count it and try again below.
            }
            await new Promise((resolve) => {
                setTimeout(resolve, STREAM_RETRY_MS).unref();
            });
        }
    })();
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

// OpenCode's id for the Gemini-through-the-translator provider; not "google", which is OpenCode's own Google provider
// (a Generative-Language API key) and would bypass the account fleet.
export const OPENCODE_GEMINI_PROVIDER = "intentic-gemini";

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
    } = {},
): OpenCodeService => {
    const { gemini, workspaceRoot } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
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
        // Gemini rows read once here since OpenCode fixes provider config at spawn; a failed catalog read degrades to
        // no Gemini provider rather than losing Grok's runtime too.
        const geminiModels = gemini === undefined ? [] : await gemini.models().catch(() => []);
        const geminiProvider = geminiProviderConfig(gemini, geminiModels);
        // createOpencodeServer inherits process.env with no override seam, so XDG_DATA_HOME and PATH are pinned only
        // across the synchronous spawn and restored after, keeping other subprocess spawns (Claude/Codex) unaffected.
        // PATH puts an engine-store OpenCode copy in front so an Environment-card install is actually used.
        const previous = process.env["XDG_DATA_HOME"];
        const previousPath = process.env["PATH"];
        const stored = await engineBinary("opencode", "opencode");
        process.env["XDG_DATA_HOME"] = xdgDataHome;
        if (stored !== undefined) {
            process.env["PATH"] = `${dirname(stored)}:${previousPath ?? ""}`;
        }
        let server: { url: string; close(): void };
        try {
            server = await createOpencodeServer({
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
            });
        } finally {
            if (previous === undefined) {
                delete process.env["XDG_DATA_HOME"];
            } else {
                process.env["XDG_DATA_HOME"] = previous;
            }
            if (previousPath === undefined) {
                delete process.env["PATH"];
            } else {
                process.env["PATH"] = previousPath;
            }
        }
        serverHandle = server;
        const client = createOpencodeClient({ baseUrl: server.url });
        // The permission watcher rides this boot; the workspace root is the one scope worth opening unasked, since an
        // isolated turn's worktree registers itself via watch().
        if (workspaceRoot !== undefined) {
            watched.add(workspaceRoot);
            watchSessionEvents(client, workspaceRoot);
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
    const modelStore = jsonFile<string[]>(modelsPath, {
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
            watchSessionEvents(await ensure(), directory);
        },
        connected: async (providerID) => {
            // Reads the persisted credential directly, not provider.list().connected, which OpenCode computes once at
            // server-init and never refreshes after a runtime auth.set().
            const entry = (await readAuth())[providerID];
            return entry?.type === "oauth" && typeof entry.access === "string";
        },
        sessionExists: async (sessionId, directory) => {
            try {
                const client = await ensure();
                return (await client.session.get({ path: { id: sessionId }, query: { directory } })).data !== undefined;
            } catch {
                return false;
            }
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
