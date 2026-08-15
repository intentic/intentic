import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareUnrankedModelIds } from "@intentic/sandbox-contract";
import {
    type Config as OpenCodeConfig,
    createOpencodeClient,
    createOpencodeServer,
    type Event as OpenCodeEvent,
    type OpencodeClient,
} from "@opencode-ai/sdk";
import { noteDelegationSignal } from "../agent/subagents.js";
import { discoverXaiModels, humanizeModelId, isChatModel, SEED_XAI_MODELS } from "./grok-models.js";

/* The shared OpenCode runtime: one warm `opencode serve` per container plus its client. Both the adapters that
 * run turns on it and the Grok auth routes (drive xAI's OAuth) need the same client, so ownership lives here
 * rather than inside an adapter. Single-tenant (one container per project), so one server is enough.
 *
 * TWO PROVIDERS RIDE IT, and they are credentialed in opposite directions — which is most of what this file's
 * shape is about:
 *
 *   xai    — OpenCode IS the credential store. It persists the xAI OAuth tokens and refreshes them itself, so
 *            there is no ClaudeStore/CodexStore twin. We pin its data dir (XDG_DATA_HOME) so those tokens
 *            survive daemon restarts, and `connected()`/`disconnect()` read/clear that store.
 *   gemini — OpenCode holds NOTHING. The credential is the translator's, exactly as it is for a Gemini turn on
 *            the Claude Code harness: the provider is declared as an OpenAI-compatible endpoint pointed at the
 *            loopback translator with its local bearer, and CLIProxyAPI supplies the real Google auth and
 *            balances the account fleet behind it. So `connected("gemini")` is a question for the translator,
 *            not for auth.json, and nothing here can answer it — planGeminiTurn asks the right thing.
 *
 * Gemini is here at all because the Claude Code loop cannot reach Google any more: that CLI bakes its own
 * "You are a Claude agent, built on Anthropic's Claude Agent SDK." into every request, and Google's Antigravity
 * channel refuses on that exact sentence (as a quota error, which sent the translator through all 31 accounts
 * before failing). Under this loop the request carries OpenCode's prompt instead. */
export interface OpenCodeService {
    // Ensure the server is up and return its client (lazy: the first turn or auth call boots it).
    readonly client: () => Promise<OpencodeClient>;
    // This directory's session-event stream, for a caller that watches one turn. Scoped, because an unscoped
    // subscription carries no session events at all — subscribeEvents has the whole story.
    readonly events: (directory: string) => Promise<{ stream: AsyncIterable<OpenCodeEvent> }>;
    // Keep a delegation watcher running for this directory, for the daemon's life. Idempotent per directory —
    // every turn calls it and only the first opens a stream. The boot covers the workspace root; this is what
    // covers an isolated conversation's worktree, which the daemon cannot know about until a turn runs there.
    readonly watch: (directory: string) => Promise<void>;
    // The warm server's base URL — what a delegated `opencode run --attach <url>` points at, so its session
    // runs where the daemon's event stream can see it (the delegation note names it; agent/delegation.ts).
    readonly url: () => Promise<string>;
    // Whether the given provider (e.g. "xai") is authenticated — read from OpenCode's persisted auth store on disk
    // (the ground truth a device sign-in writes), NOT provider.list().connected, which OpenCode computes once at
    // server-init and never refreshes after a runtime auth.set() on our long-lived server.
    readonly connected: (providerID: string) => Promise<boolean>;
    // Whether OpenCode still holds this session — the resume pre-flight every other provider already had (see
    // turn-plan.ts). Without it a chat whose session OpenCode lost (its storage cleared, a sandbox rebuild) sent
    // its prompt at a dead id and got the raw rejection back, forever: nothing told the client the id was the
    // problem, so every retry re-sent the same one. False on an unreachable server too — the turn that follows
    // starts a fresh session, which is the same recovery and a better failure than a wedged conversation.
    readonly sessionExists: (sessionId: string, directory: string) => Promise<boolean>;
    // xAI's model catalog (id + humanized label) plus a default id — ALWAYS non-empty, so the picker is never
    // blank and a send always resolves a model. Source, in order: live xAI discovery with the persisted OAuth
    // token (best, when the token is unexpired), else the last-known-good catalog persisted by recordModels, else
    // a compile-time seed floor. Supersedes provider.list() (a static models.dev snapshot whose xai list can be
    // empty and whose default is a retired id xAI rejects). Cached briefly — only real (discovered/recorded)
    // results, never the seed — so a freshened token is retried on the next read.
    readonly xaiModels: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
    // Persist the models xAI itself named as valid (parsed from a "Did you mean: …" rejection during a turn) as
    // the last-known-good catalog. This is the refresh-independent source of truth: it works even when the REST
    // discovery endpoints reject the subscription-OAuth token. Refreshes the cache so the next xaiModels() serves
    // them immediately. No-op for an empty/media-only list.
    readonly recordModels: (ids: string[]) => Promise<void>;
    // Clear a provider's stored auth AND the persisted catalog. No provider-scoped SDK removal exists, so we
    // delete OpenCode's auth store (this instance is Grok-only). ponytail: file-level clear; swap for an SDK call.
    readonly disconnect: (providerID: string) => Promise<void>;
}

// ids → the wire shape ({ models, default }); ids must be non-empty so default is always defined. Neither xAI's
// REST catalog nor its "Did you mean" rejection publishes a ranking (see model-order.ts), so the app imposes the
// order — which is what makes `default` the frontier newest rather than whichever id xAI happened to name first.
const toCatalog = (ids: readonly string[]): { models: { id: string; label: string }[]; default: string } => {
    const ordered = ids.toSorted(compareUnrankedModelIds);
    return { models: ordered.map((id) => ({ id, label: humanizeModelId(id) })), default: ordered[0]! };
};

// How long `opencode serve` gets to print its listening line. The SDK defaults to 5s, which a cold spawn misses
// on a loaded host: the binary is ~175 MB of bun paged in from scratch while boot is also warming the search
// index and starting the watchers (measured: 0.7s idle, 5–10s under that contention). Missing it is expensive —
// the failed warmup pushes the CPU-heavy spawn onto the user's first Grok call, which is exactly what warming at
// boot exists to avoid.
const BOOT_TIMEOUT_MS = 60_000;

// The rebuild-fixable state, in the user's terms. "rebuild" is load-bearing — it is the word the UI reads to
// route a state to the Environment card — so it has to survive any rewording of this sentence.
//
// `backend` is the product the USER picked, not the runtime that is missing. One `opencode serve` drives both
// providers, so the sentence that named Grok unconditionally told a user who had chosen a Google model to go
// and rebuild for a product they were not using — see openCodeBackendLabel.
export const openCodeBinaryMissing = (backend: string): string =>
    `This sandbox's image doesn't include the OpenCode CLI yet — rebuild it from the Environment card in Sandbox ▸ Environment to run ${backend} here.`;

/* THE TITLE IS THE DELEGATION'S NAME TAG — `intentic-delegation-<spawning tool call id>`.
 *
 * A delegated session has to be told apart from the OTHER sessions on the same warm server (the Grok provider
 * adapter's own turns), AND paired with the exact Bash call that started it. `opencode run` forwards no
 * environment to the server, so the id stamp that binds a codex delegation has no road here — but the title
 * does, and the same PreToolUse rewrite that stamps the environment stamps the id into this flag on its way
 * past (agent/agent-terminals.ts).
 *
 * It replaced a guess: the session used to be paired with the youngest grok delegation that did not have one
 * yet, which two concurrent runs could cross. A session whose title carries no id is simply never bound, which
 * fails toward the old blindness rather than toward binding one child's session to another's record. */
export const DELEGATION_SESSION_TITLE = "intentic-delegation";

// The id out of a delegated session's title, or undefined for every other session on the server. Anchored and
// charset-bounded (the SDK's own tool-call charset), so a title the CLI decorated after the id still pairs.
export const delegationIdOfTitle = (title: string): string | undefined =>
    new RegExp(`^${DELEGATION_SESSION_TITLE}-([A-Za-z0-9_-]+)`, "u").exec(title)?.[1];

// A session-error's human sentence, out of whichever member of OpenCode's error union carried one.
const errorText = (error: unknown): string | undefined => {
    const data = (error as { data?: { message?: unknown } } | undefined)?.data;
    return typeof data?.message === "string" && data.message !== "" ? data.message : undefined;
};

/* The warm server's news, folded into the subagent roster. A session binds on `created`, by the id its title
 * carries; everything after that is a status move keyed by session id, and noteDelegationSignal drops ids that
 * belong to no delegation — which is every primary Grok turn. `busy`/`retry` say working; `idle` is the turn's
 * end (report — a backgrounded record completes on it, a foreground one is settled by its own tool_result); a
 * pending permission is the `blocked` a waiting parent is woken for, though the warm server's allow-all config
 * makes it rare. */
const foldSessionEvent = (event: OpenCodeEvent): void => {
    switch (event.type) {
        case "session.created": {
            const info = event.properties.info;
            const delegationId = info.parentID === undefined ? delegationIdOfTitle(info.title) : undefined;
            if (delegationId !== undefined) {
                noteDelegationSignal({ delegationId, thread: info.id, event: "session" });
            }
            return;
        }
        case "session.status": {
            const { sessionID, status } = event.properties;
            noteDelegationSignal({ thread: sessionID, event: status.type === "idle" ? "report" : "working" });
            return;
        }
        case "session.idle":
            noteDelegationSignal({ thread: event.properties.sessionID, event: "report" });
            return;
        case "session.error": {
            const { sessionID, error } = event.properties;
            if (sessionID !== undefined) {
                const message = errorText(error);
                noteDelegationSignal({ thread: sessionID, event: "failed", ...(message !== undefined ? { summary: message } : {}) });
            }
            return;
        }
        case "permission.updated":
            noteDelegationSignal({ thread: event.properties.sessionID, event: "blocked" });
            return;
        case "permission.replied":
            noteDelegationSignal({ thread: event.properties.sessionID, event: "working" });
            return;
        default:
            return;
    }
};

/* EVERY PERMISSION OPENCODE HAS, ANSWERED — because the ones this block forgets do not fail, they HANG.
 *
 * The container is the isolation boundary here (same posture as Claude's bypassPermissions and Codex's
 * danger-full-access), so the intent was always allow-all. What was written was allow-THREE, and OpenCode
 * defaults the rest to `ask` — an ask that reaches a runtime with no permission channel, no TUI and nobody to
 * press anything. The session simply stops, silently, mid-turn: no error, no idle, no further events. Two
 * minutes later the adapter's inactivity watchdog aborts the turn and the user is told "timed out waiting for
 * OpenCode", which names the wrong thing entirely.
 *
 * Measured, and this is the case that found it: an ISOLATED conversation runs in a worktree while its
 * attachments stay on /work (turn-plan.ts), so reading the image the user attached is a read OUTSIDE the
 * session's directory — `external_directory`, which is not `read`. Five turns of one conversation died that
 * way in half an hour, each one 120s after asking, each one with its work half done.
 *
 * So the block is written out IN FULL against the SDK's own key list, and the type is what keeps it that way:
 * a key OpenCode adds later is a compile error here rather than another silent stall. `doom_loop` (OpenCode's
 * are-you-stuck guard) is allowed for the same reason the others are — a turn the model can't get out of is
 * bounded by the adapter's own turn cap, while a turn nobody can answer is bounded by nothing. */
const ALLOW_EVERY_PERMISSION: Required<NonNullable<OpenCodeConfig["permission"]>> = {
    edit: "allow",
    bash: "allow",
    webfetch: "allow",
    doom_loop: "allow",
    external_directory: "allow",
};

/* ...AND THE SAME ANSWER GIVEN LIVE, for the asks the block above cannot cover.
 *
 * A permission kind a future OpenCode adds is `ask` by default and unknown to the config we spawned with, which
 * puts it exactly where external_directory was: a wedged turn and a sentence blaming the clock. Any ask that
 * reaches a watched directory therefore gets a standing yes on the spot, so the worst an unknown kind can cost
 * is one round-trip rather than the turn.
 *
 * "always" rather than "once": the pattern is allowed for the rest of the session, so a tool that reads twenty
 * files under one directory asks about the first and none of the rest. */
const allowPermission = async (client: OpencodeClient, permission: { id: string; sessionID: string }, directory: string): Promise<void> => {
    await client.postSessionIdPermissionsPermissionId({
        path: { id: permission.sessionID, permissionID: permission.id },
        query: { directory },
        body: { response: "always" },
    });
};

// How many times the event stream may die in a row before the watcher gives up. The service never restarts a
// dead warm server either (`booting` is memoized for the daemon's life), so a stream that cannot come back is
// the server being gone — retrying forever would only keep test processes and dying daemons alive.
const STREAM_RETRIES = 3;
const STREAM_RETRY_MS = 5_000;

/* THE EVENT STREAM IS SCOPED TO A DIRECTORY, AND SUBSCRIBING WITHOUT ONE IS SILENTLY USELESS.
 *
 * `/event` with no `directory` still connects, still answers 200, and still delivers `server.connected` and a
 * heartbeat every twenty seconds — it simply carries no session events at all. So every turn on this runtime
 * subscribed successfully, saw its own session's events never arrive, sat out the inactivity watchdog and died
 * as "timed out waiting for OpenCode" — while the turn it was watching ran to completion upstream, spent the
 * user's allowance, and wrote its files. Measured on the warm server: an unscoped stream saw 0 of a turn's 30
 * events; the same turn on a scoped stream saw all of them, through `session.idle`.
 *
 * The scope is an EXACT directory match, not a prefix — a stream scoped to a parent sees nothing from a session
 * in its subdirectory — which is why this takes the caller's own cwd and why the delegation watcher can no
 * longer be a single server-wide subscription (see watch()).
 *
 * One helper rather than the query spelled out at each call site: a subscription that forgets the scope does not
 * fail, it goes quiet, and quiet is exactly what took two days to find the first time. */
const subscribeEvents = async (client: OpencodeClient, directory: string): ReturnType<OpencodeClient["event"]["subscribe"]> =>
    client.event.subscribe({ query: { directory } });

/* Watch ONE DIRECTORY's session events for the daemon's life — detached, started per directory the daemon runs
 * sessions in. Failures are counted, not logged loudly: losing this stream loses liveness (a delegation settles
 * only by its exit), never correctness.
 *
 * A directory, not the whole server, because that is the only stream the server will give: see subscribeEvents. */
const watchSessionEvents = (client: OpencodeClient, directory: string): void => {
    void (async () => {
        for (let failures = 0; failures < STREAM_RETRIES; failures += 1) {
            try {
                const sse = await subscribeEvents(client, directory);
                for await (const event of sse.stream) {
                    failures = 0;
                    foldSessionEvent(event as OpenCodeEvent);
                    if (event.type === "permission.updated") {
                        // Detached: the reply is a round-trip of its own, and awaiting it here would stop reading
                        // the very stream the answer's effects arrive on. A failed one leaves the ask standing,
                        // which is where it already was.
                        void allowPermission(client, event.properties, directory).catch(() => {});
                    }
                }
            } catch {
                // The stream ended or never opened — count it and try again below.
            }
            await new Promise((resolve) => {
                setTimeout(resolve, STREAM_RETRY_MS).unref();
            });
        }
    })();
};

/* What a Gemini turn on this runtime needs declared at server spawn. Absent ⇒ no Gemini provider is registered
 * and only Grok rides the loop, which is the dev profile (no translator baked) and every test that does not care.
 *
 * `models` is a thunk because the ids come off the Gemini catalog, which is built AFTER this service in the
 * composition order — and because OpenCode fixes provider config at spawn, so the list is read once, lazily, by
 * the boot that actually needs it rather than eagerly at construction. */
export interface OpenCodeGeminiConfig {
    // The translator's base URL — its OpenAI-compatible surface is at `${baseUrl}/v1`.
    readonly baseUrl: string;
    readonly token: string;
    readonly models: () => Promise<readonly string[]>;
}

// OpenCode's id for the Gemini-through-the-translator provider. Not "google": that name is taken by OpenCode's
// own Google provider (a Generative-Language API key), and a turn landing on THAT would ask the user for a key
// they were never asked for and bypass the account fleet entirely.
export const OPENCODE_GEMINI_PROVIDER = "intentic-gemini";

/* WHAT A USER-FACING SENTENCE CALLS THE BACKEND BEHIND A TURN ON THIS RUNTIME.
 *
 * One `opencode serve` drives both providers, so the adapter that serves a Gemini turn IS the Grok adapter with
 * a different `providerID` on the prompt. Every failure sentence in it was written when that was not true and
 * said "Grok" unconditionally — so a user who picked Claude Opus 4.6 on Google and whose turn stalled was told
 * "Grok turn timed out", naming a product they had not chosen and an account they had not connected.
 *
 * Keyed off the OpenCode provider id rather than our own wire id because that is what the runner carries: the
 * turn hands OpenCode a `providerID`, and this is the same value read back for the sentence. */
export const openCodeBackendLabel = (providerID: string): string => (providerID === OPENCODE_GEMINI_PROVIDER ? "Google" : "Grok");

/* An options BAG rather than more positionals: the second parameter used to be the test's fetch injection, and
 * adding real configuration behind it would have put a production concern after a test seam — the shape where
 * the next parameter goes in the wrong slot. Both are optional and both are named. */
export const createOpenCodeService = (
    xdgDataHome: string,
    options: { readonly gemini?: OpenCodeGeminiConfig; readonly fetchImpl?: typeof fetch; readonly workspaceRoot?: string } = {},
): OpenCodeService => {
    const { gemini, workspaceRoot } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    let booting: Promise<OpencodeClient> | undefined;
    // The directories a delegation watcher is already running for. Event streams are scoped to one exact
    // directory (subscribeEvents), so "watch everything" is a set of streams rather than one — and this is what
    // keeps it one PER directory however many turns run there.
    const watched = new Set<string>();
    // xAI's catalog rarely changes, so cache it briefly: a grok turn AND every Claude turn's delegation note read
    // it, and each read is an api.x.ai round-trip. Only a real result (live discovery or recordModels) is cached —
    // the seed/persisted fallbacks stay uncached so a freshened token is retried on the next read. Cleared on
    // disconnect.
    let modelsCache: { value: { models: { id: string; label: string }[]; default: string }; expiresAt: number } | undefined;
    const MODELS_TTL_MS = 60_000;
    // Where the warm server listens — set by the boot that created it, so `url()` can answer after `ensure`.
    let serverUrl: string | undefined;
    const opencodeDir = join(xdgDataHome, "opencode");
    const authPath = join(opencodeDir, "auth.json");
    // The last-known-good catalog, persisted next to auth.json so it survives daemon restarts.
    const modelsPath = join(opencodeDir, "xai-models.json");

    const boot = async (): Promise<OpencodeClient> => {
        // xAI's Responses API stores request/response server-side for 30 days by default (store: true in
        // @ai-sdk/xai) — opt every known model out via per-model options, the only seam OpenCode forwards to the
        // call. Config is fixed at server spawn, so a model first discovered later (the self-heal path) lacks the
        // flag until the next daemon restart; the persisted catalog covers it from then on.
        const storeOptOut = [...new Set([...SEED_XAI_MODELS, ...(await readPersistedModels())])];
        /* The Gemini rows, read once here because OpenCode fixes provider config at spawn. A catalog read that
         * fails degrades to no Gemini provider rather than taking the whole server down with it — Grok would
         * otherwise lose its runtime over a translator that happened to be unreachable at boot. */
        const geminiModels = gemini === undefined ? [] : await gemini.models().catch(() => []);
        /* Gemini as an OpenAI-compatible endpoint on the translator. The models have to be NAMED — OpenCode
         * builds a custom provider's catalog from config alone (there is no models.dev row for a loopback
         * endpoint), so an id it has never heard of cannot be selected. An unreadable catalog leaves this empty
         * and the provider is not registered at all, rather than registered serving nothing. */
        const geminiProvider =
            gemini === undefined || geminiModels.length === 0
                ? {}
                : {
                      [OPENCODE_GEMINI_PROVIDER]: {
                          npm: "@ai-sdk/openai-compatible",
                          name: "Gemini",
                          options: { baseURL: `${gemini.baseUrl.replace(/\/$/, "")}/v1`, apiKey: gemini.token },
                          models: Object.fromEntries(geminiModels.map((id) => [id, {}])),
                      },
                  };
        // createOpencodeServer spawns `opencode serve` inheriting process.env (it exposes no env option), so pin
        // XDG_DATA_HOME across the synchronous spawn only — the child captures it at launch; restoring right
        // after keeps the daemon's other subprocess spawns (Claude/Codex) unaffected.
        const previous = process.env["XDG_DATA_HOME"];
        process.env["XDG_DATA_HOME"] = xdgDataHome;
        let server: { url: string; close(): void };
        try {
            server = await createOpencodeServer({
                timeout: BOOT_TIMEOUT_MS,
                // No provider key — xAI auth is OAuth (stored by OpenCode). Run autonomously: the container IS the
                // isolation boundary (same posture as Claude's bypassPermissions / Codex's danger-full-access),
                // and every permission is answered here rather than most of them (ALLOW_EVERY_PERMISSION).
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
        }
        serverUrl = server.url;
        const client = createOpencodeClient({ baseUrl: server.url });
        // The delegation watcher rides the boot that made the server, so nothing ever boots one just to listen.
        // The workspace root is where a non-isolated conversation delegates from, and therefore the one scope
        // worth opening unasked; an isolated turn's worktree is registered by the turn itself (watch()).
        if (workspaceRoot !== undefined) {
            watched.add(workspaceRoot);
            watchSessionEvents(client, workspaceRoot);
        }
        return client;
    };

    // Single-flight: memoize the in-flight boot, not just the finished client. `opencode serve` takes seconds and
    // binds a fixed port, so a caller arriving mid-spawn (the first Grok connect racing the boot warmup) would
    // start a rival server, and whichever loses the bind fails its caller. Cleared on rejection so a failed boot
    // stays retryable.
    const ensure = (): Promise<OpencodeClient> => {
        booting ??= boot().catch((error: unknown) => {
            booting = undefined;
            throw error;
        });
        return booting;
    };

    // OpenCode's persisted Auth store — each provider keyed at the top level:
    // { xai: { type: "oauth", access, refresh, expires } } (`expires` is a ms epoch). {} when absent/unreadable.
    const readAuth = async (): Promise<Record<string, { type?: string; access?: string; expires?: number } | undefined>> => {
        try {
            return JSON.parse(await readFile(authPath, "utf8")) as Record<string, { type?: string; access?: string; expires?: number } | undefined>;
        } catch {
            return {};
        }
    };
    // The xAI OAuth access token, but only when it's usable for a direct api.x.ai call — i.e. present AND not past
    // its expiry. An expired token would 401 every discovery probe, so we skip discovery and serve the persisted/
    // seed catalog instead; OpenCode refreshes the token on the next turn, after which discovery works again.
    const usableXaiToken = async (): Promise<string | undefined> => {
        const entry = (await readAuth())["xai"];
        if (entry?.type !== "oauth" || typeof entry.access !== "string") {
            return undefined;
        }
        return entry.expires === undefined || Date.now() < entry.expires ? entry.access : undefined;
    };

    // Read the persisted last-known-good catalog (an array of ids). [] when absent/unreadable.
    const readPersistedModels = async (): Promise<string[]> => {
        try {
            const parsed = JSON.parse(await readFile(modelsPath, "utf8")) as unknown;
            return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
        } catch {
            return [];
        }
    };
    const writePersistedModels = async (ids: string[]): Promise<void> => {
        await mkdir(opencodeDir, { recursive: true });
        await writeFile(modelsPath, JSON.stringify(ids));
    };

    return {
        client: ensure,
        events: async (directory) => subscribeEvents(await ensure(), directory),
        watch: async (directory) => {
            if (watched.has(directory)) {
                return;
            }
            // Added BEFORE the await, so two turns starting in the same worktree in the same tick cannot both
            // get past the guard and open a stream each.
            watched.add(directory);
            watchSessionEvents(await ensure(), directory);
        },
        url: async () => {
            await ensure();
            if (serverUrl === undefined) {
                // Unreachable once ensure resolved — boot sets the url before it returns the client.
                throw new Error("OpenCode server url unknown after boot");
            }
            return serverUrl;
        },
        connected: async (providerID) => {
            // Read the persisted credential directly, NOT provider.list().connected: OpenCode computes that set
            // once at server-init and never refreshes it after a runtime auth.set(), so on our single long-lived
            // `opencode serve` a just-completed device sign-in never flips it. auth.json is what the flow writes.
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
        xaiModels: async () => {
            if (modelsCache !== undefined && Date.now() < modelsCache.expiresAt) {
                return modelsCache.value;
            }
            const token = await usableXaiToken();
            if (token !== undefined) {
                const ids = (await discoverXaiModels(token, fetchImpl)).map((model) => model.id);
                if (ids.length > 0) {
                    await writePersistedModels(ids);
                    const value = toCatalog(ids);
                    modelsCache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                    return value;
                }
            }
            // No live catalog (no token, expired, or discovery came back empty): serve the last-known-good catalog,
            // else the seed floor. Uncached so a usable token is retried next read.
            const persisted = await readPersistedModels();
            return toCatalog(persisted.length > 0 ? persisted : [...SEED_XAI_MODELS]);
        },
        recordModels: async (ids) => {
            const valid = [...new Set(ids.filter(isChatModel))];
            if (valid.length === 0) {
                return;
            }
            await writePersistedModels(valid);
            modelsCache = { value: toCatalog(valid), expiresAt: Date.now() + MODELS_TTL_MS };
        },
        disconnect: async () => {
            modelsCache = undefined;
            await rm(authPath, { force: true });
            await rm(modelsPath, { force: true });
        },
    };
};
