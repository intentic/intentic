import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createBackoff } from "@intentic/base/async";
import {
    type AccountUsage,
    type KeyedProvider,
    KeyedProviderSchema,
    type Model,
    reportsPlanLimits,
    type TranslatorAccounts,
} from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";
import type { Services } from "../composition.js";
import { compatYaml, endpointCompatEntries, translatedEndpoints } from "../endpoints/endpoint-translator.js";
import { DAEMON_OWNER, workloadStamp } from "../platform/leftovers.js";
import { engineBinary } from "../engines/engine-resolve.js";
import type { AccountUsageStore } from "../usage/account-usage.js";
import { fetchTranslatorUsage, quotaPoolFor, type TranslatorAuthFile, type TurnLimit } from "../usage/translator-usage.js";

/* The bundled translator is CLIProxyAPI: a Go proxy that lets the Claude Code harness, which speaks only the
 * Anthropic Messages API, drive OpenAI (Codex), xAI (Grok), Kimi Code and Google (Gemini) models on the user's
 * SUBSCRIPTION. CLIProxyAPI holds each provider's subscription OAuth in its auth-dir and re-serves it behind an
 * Anthropic-compatible endpoint; a routed turn (streamAgent) points ANTHROPIC_BASE_URL at config.translator.url
 * with config.translator.token as the bearer, and the model id selects the upstream provider.
 *
 * The binary is baked into the sandbox image (see the Dockerfile). On a bare `tsx watch` dev run TRANSLATOR_URL
 * is empty and startTranslator is a no-op, routed turns then surface streamAgent's clean "no translator" error.
 * The config is static (port + auth-dir + the local bearer); accounts are added/removed at runtime through the
 * Management API (see createCliProxyClient), so no config reconverge/restart is needed on a connect. */

// CLIProxyAPI's provider ids for the routed providers. Only `codex` matches ours: the app says "grok" where
// CLIProxyAPI says "xai", and "gemini" where it says "antigravity". Antigravity is Google's own agent product,
// and its channel is the one CLIProxyAPI serves Gemini models on from a plain Google-account sign-in. The app
// surfaces the model the user picks, not the Google product that vends it.
const CLIPROXY_PROVIDER: Record<KeyedProvider, string> = { codex: "codex", grok: "xai", kimi: "kimi", gemini: "antigravity" };

// The subscription-token store (survives sandbox rebuilds alongside the other AI-provider credentials).
export const cliProxyAuthDir = (authRoot: string): string => join(authRoot, "cliproxy");

// CLIProxyAPI's own provider id, back to ours, the inverse of CLIPROXY_PROVIDER, which is what an auth file on
// disk stamps itself with.
const KEYED_PROVIDER: Record<string, KeyedProvider> = Object.fromEntries(
    Object.entries(CLIPROXY_PROVIDER).map(([provider, cliproxy]) => [cliproxy, provider as KeyedProvider]),
);

/* THE CONNECTION VIEW THAT DOES NOT NEED THE PROXY, every subscription CLIProxyAPI holds, read from its
 * auth-dir on disk.
 *
 * The Management API answers the same question from the RUNNING proxy, and that is the better answer whenever
 * there is one: only the proxy knows each account's `auth_index`, which is what a quota read is addressed by. So
 * `listFiles` prefers it and falls back here, and every caller of this function is somewhere the proxy cannot
 * be asked at all:
 *
 *   · whether to spawn the proxy, and whether the translator pack belongs in the environment overlay, both run
 *     BEFORE one exists, so asking it is circular. On a core image, where the binary is absent entirely, it could
 *     only ever answer "nothing connected", which would keep the pack out of the very rebuild that installs it.
 *   · the connection list and the routed turn's credential gate, while the proxy is down, its 15s boot warm-up,
 *     or any rung of the restart ladder. An empty answer there is a lie that hides connected accounts.
 *
 * Each auth file is one account, named `<type>-<account>.json`; the `type` INSIDE it is read rather than the
 * filename parsed, since the name is CLIProxyAPI's to change. Nothing is filtered on the files' `disabled` or
 * `expired` flags: those describe an account's health, `accounts` does not filter on them either, and a stale
 * credential is still a connected subscription, the answer here has to match the list the user is looking at.
 * That last rule is the whole reason this file is read at all: a lapsed Google token is a connected account with
 * a problem, never an absent one, and it must not vanish from the card that exists to let the user renew it. */
export const authFilesOnDisk = async (authDir: string): Promise<TranslatorAuthFile[]> => {
    const names = (await readdir(authDir).catch(() => [])).filter((name) => name.endsWith(".json"));
    const files = await Promise.all(
        names.map(async (name): Promise<TranslatorAuthFile[]> => {
            const raw = await readFile(join(authDir, name), "utf8").catch(() => undefined);
            if (raw === undefined) {
                return [];
            }
            let parsed: { type?: unknown; email?: unknown };
            try {
                parsed = JSON.parse(raw) as { type?: unknown; email?: unknown };
            } catch {
                // A file half-written by a login that is still polling, it counts on the next read.
                return [];
            }
            if (typeof parsed.type !== "string" || KEYED_PROVIDER[parsed.type] === undefined) {
                return [];
            }
            /* Shaped as the Management API's own row so both sources are one type to every caller. `auth_index`
             * is deliberately absent: it is the proxy's in-memory handle for a quota read, so an account read
             * off disk renders as the connected account it is with a dot instead of a ring, which is the
             * correct answer while the thing that measures rings isn't running. */
            return [{ name, provider: parsed.type, ...(typeof parsed.email === "string" ? { email: parsed.email } : {}) }];
        }),
    );
    return files.flat();
};

export const connectedTranslatorProviders = async (authRoot: string): Promise<Set<KeyedProvider>> => {
    const files = await authFilesOnDisk(cliProxyAuthDir(authRoot));
    return new Set(
        files.flatMap((file) => {
            const keyed = file.provider === undefined ? undefined : KEYED_PROVIDER[file.provider];
            return keyed === undefined ? [] : [keyed];
        }),
    );
};

// Would a translator have anything to serve? Its two workloads are the routed SUBSCRIPTIONS above and the
// user's own openai-protocol endpoints (endpoint-translator.ts), which it re-serves as compat providers. Neither
// ⇒ starting it buys nothing, and on a core image the binary it would spawn isn't there to begin with.
export const translatorWanted = async (services: Services): Promise<boolean> =>
    (await connectedTranslatorProviders(services.authRoot)).size > 0 || translatedEndpoints(await services.capabilities.list()).length > 0;

// What a user can DO about a helper the running image doesn't carry. The word "rebuild" is required: it is
// what the UI reads to route a state to the Environment card, so it must survive any rewording of these strings.
export const TRANSLATOR_BINARY_MISSING =
    "This sandbox's image doesn't include the model translator yet: rebuild it from the Environment card in Sandbox ▸ Environment to add it.";
// The rendered server config (on /history, outside the agent's reach); the login subprocess shares it via --config.
export const cliProxyConfigPath = (config: Config): string => join(config.historyRoot, "translator", "config.yaml");
// The Management API base (localhost-only) on the same port that serves the Anthropic endpoint.
export const cliProxyManagementUrl = (config: Config): string => `${config.translator.url.replace(/\/$/, "")}/v0/management`;

/* A localhost-bound CLIProxyAPI serving the Anthropic endpoint (api-keys) + the Management API (secret-key). Both
 * accept the same fixed local bearer, the port is loopback-only.
 *
 * EVERY KEY THIS OMITS IS A GO ZERO VALUE, not CLIProxyAPI's documented default. The two are not the same, and
 * the difference is invisible: its config.example.yaml documents `quota-exceeded` as three `true`s, a missing
 * YAML bool unmarshals to `false`, and nothing anywhere says which one is in force. So the whole block is written
 * out, a routed provider's quota failover is exactly the behaviour a translator config exists to pin, and
 * leaving it to the encoding of an absent key is how all three came to be off here without a decision.
 *
 * `antigravity-credits` is the one that is off ON PURPOSE. It is the last-resort fallback to PAID AI credits once
 * every free-tier Google auth is spent on Claude models, real money, drawn per turn, with nobody asked. A routed
 * turn must not be able to reach for it; hitting the weekly wall and saying so is the correct outcome.
 *
 * `compat` is the rendered openai-compatibility block, the user's own model endpoints (endpoint-translator.ts).
 * It is rendered INTO the file rather than left to the Management API push, because this function runs on every
 * spawn and on every rung of the restart ladder below: entries that lived only in the running proxy's memory
 * would be erased by the first crash-restart, silently taking the user's endpoints out of service. */
/* HOW MANY ACCOUNTS ONE REQUEST MAY BE RETRIED ON before the refusal is the answer. CLIProxyAPI's own default
 * is 0, meaning the whole fleet, every auth file it holds, and that default is only correct if a refusal is
 * always ABOUT the account it came from. It is not.
 *
 * Google answers a request it will not serve for any reason with `RESOURCE_EXHAUSTED`, "Resource has been
 * exhausted (e.g. check quota)", including when what it objects to is the REQUEST. Measured here: a Claude Code
 * turn carries an identity line Google's Antigravity channel refuses, and every one of 31 connected accounts
 * refused it identically, in 44–62 upstream calls taking 57–69 SECONDS, while every one of those accounts sat at
 * ~0% of its weekly allowance. The fleet was not the problem and walking it could not have found an answer.
 *
 * So the walk is bounded. The number is a genuine trade and is set where the two failures cost least:
 *   too low , a real cooldown gives up while a later account had room, costing one retry the user must ask for.
 *   too high, a request nothing will serve burns the fleet and a minute of someone's attention, every time.
 * Five is enough to step over a handful of genuinely cooling credentials (which is what a transient looks like)
 * and far short of proving the same refusal 31 times. Cheap to revisit: it is one number in one rendered file.
 *
 * It does NOT make the daemon's own chain redundant, that steps between MODELS and providers, this bounds one
 * request inside one of them. */
const MAX_RETRY_CREDENTIALS = 5;

/* THE PARAMETER NO REQUEST FROM THIS SANDBOX MAY CARRY, removed at the proxy's own edge, for every model and
 * every route it serves.
 *
 * `prompt_cache_retention` is the provider's own knob, not ours: nothing in this repo sets it, and a captured
 * Codex request body does not contain it. It still ended a ten-minute turn with `400 prompt_cache_retention is
 * not supported on this model`, because the proxy's Codex paths each strip the field SEPARATELY and one of them,
 * the conversation-compaction call a long turn makes at its very end, forgot to. The pin in
 * packs/translator.Dockerfile is past that bug; this rule is what makes the guarantee independent of the pin,
 * since a `payload.filter` runs before every one of those paths, compaction included, on any version.
 *
 * Belt and braces on purpose. A pin can be bumped by someone reading a changelog, and a client we do not control
 * (a user's own tool pointed at the same loopback endpoint) can send the field at any time; neither should be
 * able to cost somebody a turn's work. `prompt_cache_key` is deliberately NOT filtered: the proxy sets it itself
 * to keep a session's cache warm, which is the saving this parameter family exists for. */
const FILTERED_PARAMETERS = ["prompt_cache_retention", "prompt_cache_options"];

// Exported for the test alone: the bounded walk above is a behaviour nothing else in this repo can observe (the
// proxy is a separate binary reading a file), so the rendered file IS the assertable surface.
export const renderConfig = (opts: { port: number; authDir: string; token: string; compat: string }): string =>
    [
        `host: "127.0.0.1"`,
        `port: ${opts.port}`,
        `auth-dir: ${JSON.stringify(opts.authDir)}`,
        `api-keys:`,
        `  - ${JSON.stringify(opts.token)}`,
        `remote-management:`,
        `  allow-remote: false`,
        `  secret-key: ${JSON.stringify(opts.token)}`,
        `quota-exceeded:`,
        `  switch-project: true`,
        `  switch-preview-model: true`,
        `  antigravity-credits: false`,
        `max-retry-credentials: ${MAX_RETRY_CREDENTIALS}`,
        `payload:`,
        `  filter:`,
        `    - models:`,
        `        - name: "*"`,
        `      params:`,
        ...FILTERED_PARAMETERS.map((parameter) => `        - ${JSON.stringify(parameter)}`),
        ...(opts.compat === "" ? [] : [opts.compat]),
        ``,
    ].join("\n");

const portOf = (url: string): number | undefined => {
    try {
        const parsed = new URL(url);
        return parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    } catch {
        return undefined;
    }
};

// The restart ladder: a proxy that crashes on arrival must not be respawned every few seconds forever (it has
// been, hundreds of spawns and log lines an hour, all saying nothing). Ten seconds after the first short life,
// doubling to five minutes; a run that survived past a minute was a working proxy whose exit is news, so the
// ladder starts over (the shared createBackoff, whose test pins this policy).
const RESTART_LADDER = { floorMs: 10_000, capMs: 300_000, stableMs: 60_000 } as const;

// The tail of the proxy's output kept per run, enough to carry a Go panic or a bind error into the exit log.
const OUTPUT_TAIL_BYTES = 2_048;

// How long after spawning the proxy the first quota sweep runs, long enough for its management API to be
// listening, short enough that opening the Agent tab straight after a restart still finds rings.
const WARMUP_DELAY_MS = 15_000;

// Start the CLIProxyAPI server and keep it alive. Best-effort and non-throwing: a routed turn that finds it down
// surfaces its own error. Returns immediately; the proxy runs for the daemon's lifetime. No-op when no translator
// is baked (config.translator.url empty, the dev path).
export const startTranslator = (services: Services): void => {
    const { config, authRoot, logger } = services;
    if (config.translator.url === "") {
        return;
    }
    const port = portOf(config.translator.url);
    if (port === undefined) {
        logger.warn({ url: config.translator.url }, "translator: unparseable TRANSLATOR_URL, not starting");
        return;
    }
    const authDir = cliProxyAuthDir(authRoot);
    const configPath = cliProxyConfigPath(config);
    let child: ChildProcess | undefined;
    const ladder = createBackoff(RESTART_LADDER);

    const start = async (): Promise<void> => {
        await mkdir(authDir, { recursive: true });
        await mkdir(dirname(configPath), { recursive: true });
        // The trial's entry bakes the platform's address into the config, and on a dev machine that address is
        // the loopback tunnel's, which binds concurrently with this spawn. Waiting for its final answer (bound,
        // failed, or not needed: settled either way, see PlatformTunnel.ready) is what makes the rendered
        // config deterministic instead of almost-always-right.
        await services.platformTunnel.ready;
        // The user's own endpoints, resolved before the spawn so the proxy comes up already serving them. Their
        // catalogs fall back to a persisted list, so a model server that happens to be down right now keeps its
        // entry instead of being rendered out of the config until something asks again.
        const compat = compatYaml(await endpointCompatEntries(services).catch(() => []));
        await writeFile(configPath, renderConfig({ port, authDir, token: config.translator.token, compat }), { mode: 0o600 });
        const startedAt = Date.now();
        // The proxy states WHY it exited (a taken port, a bad config, a panic) in its own log, and that log
        // goes to STDOUT. Its stderr stays empty even for a fatal `bind: address already in use`, so watching
        // stderr alone is why hundreds of restarts each reported a bare `code: 0` beside an empty reason while
        // the one line that named the cause was being discarded. Both streams, one tail, in the order said.
        let outputTail = "";
        const keepTail = (chunk: Buffer): void => {
            outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
        };
        // Daemon-owned: supervised here with its own restart ladder, so it is never abandoned in this life,
        // the stamp is what lets a NEXT daemon recognise the copy this one left behind (platform/leftovers.ts).
        /* The store's copy when an owner has taken one, the pack's global install otherwise, and the bare name
         * when neither is here — which spawns, fails ENOENT, and is reported as the missing pack it is
         * (engines/engine-resolve.ts). */
        const binary = (await engineBinary("translator", "cli-proxy-api")) ?? "cli-proxy-api";
        child = spawn(binary, ["--config", configPath], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...workloadStamp(DAEMON_OWNER) },
        });
        child.stdout?.on("data", keepTail);
        child.stderr?.on("data", keepTail);
        child.on("exit", (code) => {
            child = undefined;
            const restartInMs = ladder.next(Date.now() - startedAt);
            logger.warn({ code, output: outputTail.trim(), restartInMs }, "translator: cli-proxy-api exited, restarting");
            setTimeout(() => void start().catch((error: unknown) => logger.warn({ err: error }, "translator restart failed")), restartInMs).unref();
        });
    };

    void start().catch((error: unknown) => logger.warn({ err: error }, "translator: initial start failed"));

    /* Warm the routed accounts' headroom once the proxy is answering. Without this the first person to open the
     * Agent tab after a restart reads a cold store and gets dots, because `accounts` serves what is on file and
     * schedules the pull rather than waiting for it, the tab would fill in only on a later visit. The delay is
     * for the proxy's own startup: the management API is what these reads go through, and a sweep fired the
     * instant the child is spawned would simply find nothing listening. Best-effort like everything else here. */
    setTimeout(
        () => void services.cliProxy.refreshUsage().catch((error: unknown) => logger.warn({ err: error }, "translator: usage warm-up failed")),
        WARMUP_DELAY_MS,
    ).unref();
};

// The CLIProxyAPI Management API client + login orchestration the /translator routes and the routed-turn gate
// use. `accounts` reads the connected subscriptions per provider, a LIST, because CLIProxyAPI holds any number
// of auth files per provider and balances requests across them, so a second account is more headroom; `connect`
// starts a provider's login and returns what the card shows; `complete` finishes the one provider whose login
// can't self-complete (see below); `disconnect` clears ONE account's tokens by auth-file name.
//
// Codex, Grok and Kimi are device-code logins: the user opens a URL and approves, and CLIProxyAPI polls to
// completion in the background and writes the token to auth-dir, so the UI polls `accounts` until connected and
// never calls `complete`. Google's is a browser redirect to a loopback port that only exists inside this
// container, so nothing can observe the grant, the user pastes the URL they landed on and `complete` hands it
// back to CLIProxyAPI, which then finishes the exchange on its own and the UI polls `accounts` the same way.
interface TranslatorLogin {
    readonly url: string;
    readonly code: string;
    readonly state: string;
    readonly flow: "device" | "redirect";
}

export interface CliProxyClient {
    // The connection inventory, each row carrying whatever headroom is on file for it. ONE method, and it never
    // waits on an upstream quota call: this is the routed-turn credential gate as well as the settings list, so
    // a round-trip here would land on every routed turn's startup path. Freshness comes from the refresh this
    // read SCHEDULES, not from one it waits for, see the store policy below.
    readonly accounts: () => Promise<TranslatorAccounts>;
    // Pull every readable account's quota now and record it. The daemon calls this once at boot so the first
    // person to open the Agent tab already has rings to look at.
    readonly refreshUsage: () => Promise<void>;
    // What the recorded quota says about the pool THIS TURN'S MODEL spends, across every account connected for
    // the provider, for the turn that was just refused by it. Reads the recorded snapshots only; see the
    // implementation for why the refusal itself cannot answer this.
    readonly turnLimit: (provider: KeyedProvider, model: string) => Promise<TurnLimit>;
    readonly connect: (provider: KeyedProvider) => Promise<TranslatorLogin>;
    readonly complete: (input: { provider: KeyedProvider; redirectUrl: string; state: string }) => Promise<void>;
    readonly disconnect: (provider: KeyedProvider, name: string) => Promise<void>;
    readonly models: (provider: KeyedProvider) => Promise<Model[]>;
}

// An account's key in the shared usage store, namespaced by provider, an auth-file name is only unique
// within the provider it belongs to, and the store is shared with the native accounts.
const usageKey = (provider: KeyedProvider, name: string): string => `${provider}:${name}`;

export const createCliProxyClient = (params: {
    managementUrl: string;
    token: string;
    configPath: string;
    authDir: string;
    usageStore: AccountUsageStore;
    fetchFn?: typeof fetch;
    binaryPresent?: () => Promise<boolean>;
}): CliProxyClient => {
    const { managementUrl, token, configPath, authDir, usageStore } = params;
    const fetchFn = params.fetchFn ?? fetch;
    // The store counts as present: a core image bakes no translator, and an owner who installed one from the
    // Environment card has a working binary that PATH knows nothing about.
    const binaryPresent = params.binaryPresent ?? (async () => (await engineBinary("translator", "cli-proxy-api")) !== undefined);
    const auth = { authorization: `Bearer ${token}` };

    /* WHY THE PROXY DIDN'T ANSWER, which is two entirely different situations with two different things for the
     * user to do, and they used to share one sentence.
     *
     * No binary in this image is a core image missing the translator pack, fixed by a rebuild. A binary that IS
     * here and still isn't answering is a proxy mid-boot (its Management API listens a beat after the spawn) or
     * mid-restart on its backoff ladder, fixed by waiting a moment. Telling the second group to rebuild their
     * image sends them off to do something slow that changes nothing, and it is what every new user saw in the
     * seconds between their sandbox starting and the proxy binding its port. */
    const unreachable = async (cause?: unknown): Promise<Error> =>
        (await binaryPresent())
            ? new Error("The model translator isn't answering yet: it may still be starting up. Try again in a moment.", { cause })
            : new Error(TRANSLATOR_BINARY_MISSING, { cause });

    /* EVERY SUBSCRIPTION THIS SANDBOX HOLDS, from the running proxy when it is up, and from its credential
     * store on disk when it is not.
     *
     * The disk fallback is the difference between "we couldn't ask" and "there is nothing there", and getting
     * those two confused is what made a shelf of connected Google accounts disappear from the Agent tab and come
     * back as a Connect button. The proxy is down for real windows: 15s of boot warm-up, and up to 5 minutes on
     * the restart ladder's ceiling, and this read is BOTH the settings list and the routed turn's credential
     * gate, so an empty answer in that window told the user they had never signed in and told their turn there
     * was nothing to run on. The tokens were on disk the whole time, which is where connectedTranslatorProviders
     * has always read them from for exactly this reason.
     *
     * Both shapes of unreachable fall through here: a non-ok answer (proxy still booting / not baked) and the
     * fetch itself throwing, a dead port, or no translator configured at all (an empty TRANSLATOR_URL makes
     * this a relative URL, which fetch rejects before it ever dials). The local dev profile lives in that last
     * shape permanently and reads its accounts off disk from now on. */
    const listFiles = async (): Promise<TranslatorAuthFile[]> => {
        const response = await fetchFn(`${managementUrl}/auth-files`, { headers: auth }).catch(() => undefined);
        if (response === undefined || !response.ok) {
            return authFilesOnDisk(authDir);
        }
        return ((await response.json()) as { files?: TranslatorAuthFile[] }).files ?? [];
    };

    // CLIProxyAPI's xAI and Kimi logins are headless-friendly device flows exposed over the Management API. Each
    // returns a verification URL, optional user code and state, then polls to completion in the background.
    const connectDevice = async (provider: "grok" | "kimi"): Promise<TranslatorLogin> => {
        const response = await fetchFn(`${managementUrl}/${provider === "grok" ? "xai" : "kimi"}-auth-url`, { headers: auth }).catch(
            async (err: unknown) => {
                throw await unreachable(err);
            },
        );
        if (!response.ok) {
            throw new Error(`${provider === "grok" ? "xAI" : "Kimi Code"} subscription login failed to start (${response.status})`);
        }
        const body = (await response.json()) as { url?: string; user_code?: string; state?: string };
        if (body.url === undefined || body.state === undefined || body.state === "") {
            throw new Error(`${provider === "grok" ? "xAI" : "Kimi Code"} subscription login returned an incomplete device flow`);
        }
        return { url: body.url, code: body.user_code ?? "", state: body.state, flow: "device" };
    };

    // Gemini: CLIProxyAPI's Antigravity login is Google's ordinary browser OAuth, it hands back an authorize URL
    // and a `state`, then waits for the grant to land in its auth-dir. Google redirects to a loopback port bound
    // inside THIS container, which the user's browser can never reach, so the redirect always dead-ends in their
    // address bar; that URL carries the grant, and `complete` below posts it back. No device-code flow exists for
    // Google; the explicit redirect flow tells the card to ask for the landing URL.
    const connectGemini = async (): Promise<TranslatorLogin> => {
        const response = await fetchFn(`${managementUrl}/antigravity-auth-url`, { headers: auth }).catch(async (err: unknown) => {
            throw await unreachable(err);
        });
        if (!response.ok) {
            throw new Error(`Google sign-in failed to start (${response.status})`);
        }
        const body = (await response.json()) as { url?: string; state?: string };
        if (body.url === undefined || body.state === undefined || body.state === "") {
            throw new Error("Google sign-in returned no authorization URL");
        }
        return { url: body.url, code: "", state: body.state, flow: "redirect" };
    };

    // Hand a pasted redirect URL back to CLIProxyAPI, which parses ?code=&state= out of it, matches it to the
    // pending session and resumes the token exchange in the background. Its rejections are the ones worth
    // reading (an expired handshake, a state that belongs to a different login), so surface its own message.
    const complete = async (input: { provider: KeyedProvider; redirectUrl: string; state: string }): Promise<void> => {
        const response = await fetchFn(`${managementUrl}/oauth-callback`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ provider: CLIPROXY_PROVIDER[input.provider], redirect_url: input.redirectUrl, state: input.state }),
        }).catch(async (err: unknown) => {
            throw await unreachable(err);
        });
        if (!response.ok) {
            const reason = ((await response.json().catch(() => undefined)) as { error?: string } | undefined)?.error;
            throw new Error(reason ?? `Sign-in could not be completed (${response.status})`);
        }
    };

    // Codex: CLIProxyAPI's Management API Codex login is a browser-redirect flow (loopback callback) that can't
    // complete in a remote sandbox. Its device-code flow is only exposed as the `--codex-device-login` CLI command,
    // so drive that as a subprocess: parse the URL + code it prints, surface them, and leave it running to poll to
    // completion (writing the token to auth-dir). A superseding connect kills the prior child.
    let codexChild: ChildProcess | undefined;
    const connectCodex = async (): Promise<TranslatorLogin> => {
        // Resolved before the executor, which is synchronous: the login has to drive the SAME binary the
        // supervised proxy does, or a store copy would sign in through the image's.
        const binary = (await engineBinary("translator", "cli-proxy-api")) ?? "cli-proxy-api";
        return new Promise((resolve, reject) => {
            codexChild?.kill("SIGTERM");
            const child = spawn(binary, ["--codex-device-login", "--no-browser", "--config", configPath], {
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, ...workloadStamp(DAEMON_OWNER) },
            });
            codexChild = child;
            let buffer = "";
            let url: string | undefined;
            let code: string | undefined;
            let settled = false;
            const onData = (chunk: Buffer): void => {
                buffer += chunk.toString();
                url = buffer.match(/Codex device URL:\s*(\S+)/)?.[1] ?? url;
                code = buffer.match(/Codex device code:\s*(\S+)/)?.[1] ?? code;
                if (!settled && url !== undefined && code !== undefined) {
                    settled = true;
                    // The subprocess owns the poll to completion, so there is no handshake for the UI to resume.
                    resolve({ url, code, state: "", flow: "device" });
                }
            };
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("error", (error) => {
                if (!settled) {
                    settled = true;
                    // A core image carries no cli-proxy-api, so the spawn fails ENOENT, a message naming a
                    // binary the user has never heard of, for a state they can actually fix.
                    reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(TRANSLATOR_BINARY_MISSING) : error);
                }
            });
            child.on("exit", (exitCode) => {
                if (child === codexChild) {
                    codexChild = undefined;
                }
                // Exit before we saw a code ⇒ the flow failed to start. Exit after ⇒ the poll finished (success or
                // timeout); the UI already learned the outcome by polling `accounts`.
                if (!settled) {
                    settled = true;
                    reject(new Error(`Codex device login exited (${exitCode}) before printing a code`));
                }
            });
        });
    };

    // Drop ONE account: the provider check keeps a name from another provider's file (or a stale row) from
    // deleting a credential the user didn't point at. A pending codex device login still dies with any codex
    // disconnect, its poll would otherwise re-land a token into a store the user is clearing out. The account's
    // snapshot goes with it, exactly as /claude/accounts drops a disconnected account's: leaving it behind would
    // hand its headroom straight back to the next account to be given the same auth-file name.
    const disconnect = async (provider: KeyedProvider, name: string): Promise<void> => {
        if (provider === "codex") {
            codexChild?.kill("SIGTERM");
            codexChild = undefined;
        }
        const cliproxyProvider = CLIPROXY_PROVIDER[provider];
        for (const file of await listFiles()) {
            if (file.provider === cliproxyProvider && file.name === name) {
                /* The proxy OWNS the delete, it holds the credential in memory as well as on disk, so removing
                 * the file behind its back would leave a live account serving turns off a token the user believes
                 * they revoked. So a proxy that isn't answering means the disconnect did not happen, and saying so
                 * is the only honest answer: the row this list now draws from disk is reachable while the proxy is
                 * down, which is exactly when a silently-swallowed DELETE would report success and change nothing.
                 */
                const response = await fetchFn(`${managementUrl}/auth-files?name=${encodeURIComponent(file.name)}`, {
                    method: "DELETE",
                    headers: auth,
                }).catch(async (err: unknown) => {
                    throw await unreachable(err);
                });
                if (!response.ok) {
                    throw new Error(`The translator refused to drop that account (${response.status}).`);
                }
                attemptedAt.delete(usageKey(provider, name));
                await usageStore.clear(usageKey(provider, name));
            }
        }
    };

    /* WHERE a routed account's headroom lives, and how often it is re-read.
     *
     * The readings themselves go in the shared account-usage store, exactly as a Claude turn's do, so a page
     * load draws its rings from disk instead of owing an upstream round-trip per account, and a daemon restart
     * doesn't blank the Agent tab. Namespaced by provider because that store is shared with the native accounts:
     * an auth-file name is only unique within its own provider.
     *
     * `attemptedAt` deliberately records when each account was last ASKED, not what it answered. The store
     * caches the successes; this is what bounds the FAILURES, an upstream that is down, or one that answers
     * with no quota at all, would otherwise be retried on every call, and `accounts` is called on every routed
     * turn and every three seconds for as long as a connect flow is open. */
    const REFRESH_AFTER_MS = 5 * 60_000;
    const attemptedAt = new Map<string, number>();

    /* Every auth file whose quota this client can actually read, paired with the provider it belongs to.
     *
     * `auth_index` is the proxy's own handle for the account, and a quota read is addressed by it, so a row that
     * has none is not readable, whatever else is true of it. That is every row `listFiles` recovers from disk
     * while the proxy is down (authFilesOnDisk), and without this filter each one would look permanently overdue:
     * a sweep would fire on every `accounts` call, once per routed turn, and every three seconds through a
     * connect flow, to ask an upstream it has no address for and record nothing. */
    const readableFiles = (files: readonly TranslatorAuthFile[]): { provider: KeyedProvider; file: TranslatorAuthFile; key: string }[] =>
        KeyedProviderSchema.options
            .filter(reportsPlanLimits)
            .flatMap((provider) =>
                files.flatMap((file) =>
                    file.provider === CLIPROXY_PROVIDER[provider] && file.name !== undefined && file.auth_index !== undefined
                        ? [{ provider, file, key: usageKey(provider, file.name) }]
                        : [],
                ),
            );

    /* One sweep of upstream reads. Concurrency is bounded because a sandbox can hold dozens of Google accounts
     * and firing every request at once is how a refresh becomes a self-inflicted rate limit. A failed or
     * quota-less read records the attempt and nothing else, so the last good snapshot stays where it is instead
     * of being replaced by a blank. */
    const REFRESH_CONCURRENCY = 4;
    const refreshUsage = async (): Promise<void> => {
        const pending = readableFiles(await listFiles());
        const worker = async (): Promise<void> => {
            for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
                attemptedAt.set(next.key, Date.now());
                const usage = await fetchTranslatorUsage({
                    fetchFn,
                    managementUrl,
                    managementToken: token,
                    provider: next.provider,
                    file: next.file,
                });
                if (usage !== undefined) {
                    await usageStore.record(next.key, usage);
                }
            }
        };
        await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, worker));
    };

    // Refresh what has gone stale, in the background, never awaited by `accounts`, whose answer is drawn from
    // what is already on file. The rings a sweep produces are for the NEXT read, and that is precisely what
    // keeps an upstream quota call off the routed turn's startup path.
    let refreshing = false;
    const refreshStale = (files: readonly TranslatorAuthFile[], stored: Record<string, AccountUsage>): void => {
        const now = Date.now();
        const due = readableFiles(files).some(
            (entry) => stored[entry.key] === undefined || now - (attemptedAt.get(entry.key) ?? 0) > REFRESH_AFTER_MS,
        );
        if (!due || refreshing) {
            return;
        }
        refreshing = true;
        void refreshUsage()
            .catch(() => undefined)
            .finally(() => {
                refreshing = false;
            });
    };

    /* WHETHER THIS PROVIDER CAN SERVE THIS MODEL AT ALL, and when it next can, read from the snapshots above
     * rather than from the refusal, because the refusal cannot say. CLIProxyAPI balances across every auth file
     * it holds and walks the whole set on a quota 429, so what comes back is the LAST word on the fleet ("All
     * credentials for model X are cooling down") with no account named and no per-account reset in it. The
     * quota reads do carry both, for every account, and cost nothing here, they are already on file.
     *
     * SCOPED TO THE POOL THE MODEL SPENDS (quotaPoolFor), which is the correction that makes the rest of this
     * true. Google meters Gemini and the Claude/GPT models as separate weekly allowances off one sign-in; the
     * earliest exhausted window across every account and every pool answered a Claude Opus turn with the Gemini
     * pool's instant, on an account that was not serving it, while another account still had room in the pool
     * the turn was really spending.
     *
     * An account counts as spent when ANY pool this model draws on is spent, it is gated by its tightest, and
     * for Codex and Kimi (one undivided plan, so every window counts) a spent 5-hour throttle stops a turn that
     * the weekly pool would have allowed. An account with no reading for the pool counts in neither tally; the
     * caller reads two zeroes as "nothing on file" and claims nothing about the fleet.
     *
     * The reset stays the EARLIEST spent account's, because any one of them reopening unblocks the turn, and it
     * is deliberately absent while anything still has headroom, see TurnLimit. One deliberate imprecision
     * remains, erring early: a snapshot up to REFRESH_AFTER_MS stale can miss an account that has since hit its
     * wall. Early costs one retry that fails the same way; late leaves someone waiting past a window that
     * already reopened. */
    const turnLimit = async (provider: KeyedProvider, model: string): Promise<TurnLimit> => {
        const pool = quotaPoolFor(provider, model);
        const [files, stored] = await Promise.all([listFiles(), usageStore.read()]);
        let spent = 0;
        let withHeadroom = 0;
        const resets: number[] = [];
        for (const file of files) {
            if (file.provider !== CLIPROXY_PROVIDER[provider] || file.name === undefined) {
                continue;
            }
            const windows = (stored[usageKey(provider, file.name)]?.windows ?? []).filter(
                (window) => pool === undefined || window.kind === pool.kind,
            );
            if (windows.length === 0) {
                continue;
            }
            const exhausted = windows.filter((window) => window.utilization >= 100);
            if (exhausted.length === 0) {
                withHeadroom += 1;
                continue;
            }
            spent += 1;
            resets.push(...exhausted.flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt])));
        }
        return {
            ...(pool === undefined ? {} : { pool: pool.label }),
            spent,
            withHeadroom,
            ...(withHeadroom > 0 || resets.length === 0 ? {} : { reopensAt: Math.min(...resets) }),
        };
    };

    return {
        accounts: async () => {
            const [files, stored] = await Promise.all([listFiles(), usageStore.read()]);
            refreshStale(files, stored);
            const of = (provider: KeyedProvider) =>
                files.flatMap((file) => {
                    if (file.provider !== CLIPROXY_PROVIDER[provider] || file.name === undefined) {
                        return [];
                    }
                    const usage = stored[usageKey(provider, file.name)];
                    return [{ name: file.name, label: file.email ?? file.label ?? file.name, ...(usage === undefined ? {} : { usage }) }];
                });
            return { codex: of("codex"), grok: of("grok"), kimi: of("kimi"), gemini: of("gemini") };
        },
        refreshUsage,
        turnLimit,
        connect: (provider) =>
            provider === "grok" || provider === "kimi" ? connectDevice(provider) : provider === "gemini" ? connectGemini() : connectCodex(),
        complete,
        disconnect,
        models: async (provider) => {
            const response = await fetchFn(`${managementUrl}/model-definitions/${CLIPROXY_PROVIDER[provider]}`, { headers: auth }).catch(
                () => undefined,
            );
            if (response === undefined || !response.ok) {
                throw new Error(`${provider} model catalog unavailable (${response?.status ?? "unreachable"})`);
            }
            const body = (await response.json()) as {
                models?: { id?: string; display_name?: string; description?: string; thinking?: { levels?: string[] } }[];
            };
            return (body.models ?? []).flatMap((model) =>
                model.id === undefined || model.id === ""
                    ? []
                    : [
                          {
                              id: model.id,
                              label: model.display_name ?? model.id,
                              ...(model.description !== undefined && model.description !== "" ? { description: model.description } : {}),
                              ...(model.thinking?.levels !== undefined ? { efforts: model.thinking.levels } : {}),
                          },
                      ],
            );
        },
    };
};
