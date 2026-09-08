import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createBackoff } from "@intentic/base/async";
import {
    cliProxyIdOf,
    type KeyedProvider,
    KeyedProviderSchema,
    type Model,
    reportsPlanLimits,
    type TranslatorAccounts,
} from "@intentic/sandbox-contract";
import type { Config } from "../../env.config.js";
import type { Services } from "../../composition.js";
import { compatYaml, endpointCompatEntries, translatedEndpoints } from "../../endpoints/endpoint-translator.js";
import { DAEMON_OWNER, workloadStamp } from "../../platform/boot/leftovers.js";
import { engineBinary } from "../../engines/engine-resolve.js";
import type { AccountUsageStore } from "../../usage/account-usage.js";
import { fleetLimit, type TurnLimit } from "../../usage/fleet-limit.js";
import type { HeadroomSource } from "../../usage/headroom.js";
import { authFileCooling, fetchTranslatorUsage, type TranslatorAuthFile } from "../../usage/translator-usage.js";

// CLIProxyAPI: a bundled Go proxy that lets the Claude Code harness (Anthropic Messages only) drive
// Codex/Grok/Kimi/Gemini on the user's subscription, behind an Anthropic-compatible endpoint keyed by model id. Config
// is static; accounts are added/removed at runtime via the Management API, no restart needed.

// Our provider ids to CLIProxyAPI's (grok/xai, gemini/antigravity), derived from each provider's spec row.
const CLIPROXY_PROVIDER: Record<KeyedProvider, string> = Object.fromEntries(
    KeyedProviderSchema.options.map((provider) => [provider, cliProxyIdOf(provider) ?? provider] as const),
) as Record<KeyedProvider, string>;

// The subscription-token store; survives sandbox rebuilds alongside the other AI-provider credentials.
export const cliProxyAuthDir = (authRoot: string): string => join(authRoot, "cliproxy");

// Inverse of CLIPROXY_PROVIDER: what an auth file on disk stamps itself with.
const KEYED_PROVIDER: Record<string, KeyedProvider> = Object.fromEntries(
    Object.entries(CLIPROXY_PROVIDER).map(([provider, cliproxy]) => [cliproxy, provider as KeyedProvider]),
);

// Connection view that doesn't need a running proxy: reads subscriptions off the auth-dir, for callers when the proxy
// can't be asked (before it exists, or while down). A stale credential still counts as connected.
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
                // A file half-written by a login still polling; it counts on the next read.
                return [];
            }
            if (typeof parsed.type !== "string" || KEYED_PROVIDER[parsed.type] === undefined) {
                return [];
            }
            // Shaped like the Management API's row; `auth_index` is absent, only the proxy can supply it.
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

// Whether starting the translator would serve anything: a subscription or a user's own endpoint connected.
export const translatorWanted = async (services: Services): Promise<boolean> =>
    (await connectedTranslatorProviders(services.authRoot)).size > 0 || translatedEndpoints(await services.capabilities.list()).length > 0;

// The word 'rebuild' is required: the UI matches it to route the error to the Environment card.
export const TRANSLATOR_BINARY_MISSING =
    "This sandbox's image doesn't include the model translator yet: rebuild it from the Environment card in Sandbox ▸ Environment to add it.";
// The rendered server config, outside the agent's reach; the login subprocess shares it via --config.
export const cliProxyConfigPath = (config: Config): string => join(config.historyRoot, "translator", "config.yaml");
// The Management API base (localhost-only) on the same port that serves the Anthropic endpoint.
export const cliProxyManagementUrl = (config: Config): string => `${config.translator.url.replace(/\/$/, "")}/v0/management`;

// Every field is written explicitly: an omitted key unmarshals to Go's zero value, not CLIProxyAPI's documented
// default. `antigravity-credits` is off on purpose: the paid-credits fallback must not spend real money unasked.
// Retries one request across at most this many accounts; CLIProxyAPI's own default (0) means the whole fleet.
const MAX_RETRY_CREDENTIALS = 5;

// Stripped from every request at the proxy's edge; `prompt_cache_key` stays, keeping the session cache warm.
const FILTERED_PARAMETERS = ["prompt_cache_retention", "prompt_cache_options"];

// Exported for the test alone: the proxy is a separate binary reading this file, so the rendered output is the only
// assertable surface.
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

// Restart backoff: 10s doubling to 5min; a run past a minute resets the ladder (createBackoff).
const RESTART_LADDER = { floorMs: 10_000, capMs: 300_000, stableMs: 60_000 } as const;

// The tail of the proxy's output kept per run, enough to carry a Go panic or a bind error into the exit log.
const OUTPUT_TAIL_BYTES = 2_048;

// How long after spawn the quota sweep runs first: enough for the API to listen, short of an early tab open.
const WARMUP_DELAY_MS = 15_000;

// Starts CLIProxyAPI and keeps it alive for the daemon's life; best-effort and non-throwing, returns immediately. No-op
// when no translator is baked (empty translator URL).
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
        // Waits for the platform tunnel to settle, so the rendered address is deterministic.
        await services.platformTunnel.ready;
        // Resolved before spawn so the proxy serves these at once; a down server keeps its persisted entry.
        const compat = compatYaml(await endpointCompatEntries(services).catch(() => []));
        await writeFile(configPath, renderConfig({ port, authDir, token: config.translator.token, compat }), { mode: 0o600 });
        const startedAt = Date.now();
        // The proxy logs its exit reason on stdout, not stderr; both streams are captured, in order.
        let outputTail = "";
        const keepTail = (chunk: Buffer): void => {
            outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
        };
        // Daemon-owned and stamped, so a later daemon can recognize this as its own leftover.
        // Falls back from a store copy, to the pack install, to the bare name, reported as missing.
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

    // Warms headroom once the proxy should be up, so the first tab after a restart isn't cold.
    setTimeout(() => void services.headroom.refresh({ scope: { providers: KeyedProviderSchema.options }, maxAgeMs: 0 }), WARMUP_DELAY_MS).unref();
};

// Management API client and login orchestration for /translator routes and the routed-turn gate. Codex/Grok/Kimi are
// device-code logins the proxy polls to completion; Google is a redirect whose landing URL `complete` hands back.
interface TranslatorLogin {
    readonly url: string;
    readonly code: string;
    readonly state: string;
    readonly flow: "device" | "redirect";
}

export interface CliProxyClient {
    // Connection inventory with on-file headroom; never waits on upstream, since it gates every turn's start.
    readonly accounts: () => Promise<TranslatorAccounts>;
    // The routed half of the headroom service: one target per auth file whose quota the proxy can read.
    readonly headroom: HeadroomSource;
    // The one account a pushed reading can be filed under, only when a provider holds exactly one file.
    readonly sharedUsageKey: (provider: KeyedProvider) => Promise<string | undefined>;
    // What the recorded quota says about the pool this turn's model spends, across the provider's accounts.
    readonly turnLimit: (provider: KeyedProvider, model: string) => Promise<TurnLimit>;
    readonly connect: (provider: KeyedProvider) => Promise<TranslatorLogin>;
    readonly complete: (input: { provider: KeyedProvider; redirectUrl: string; state: string }) => Promise<void>;
    readonly disconnect: (provider: KeyedProvider, name: string) => Promise<void>;
    readonly models: (provider: KeyedProvider) => Promise<Model[]>;
}

// Namespaced by provider since the store is shared with native accounts and a file name is unique only within one.
// Exported for translator.routes.ts, which forgets a disconnected account's snapshot.
export const usageKey = (provider: KeyedProvider, name: string): string => `${provider}:${name}`;

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
    // Counts as present: a core image bakes none, and an installed binary may be invisible to PATH.
    const binaryPresent = params.binaryPresent ?? (async () => (await engineBinary("translator", "cli-proxy-api")) !== undefined);
    const auth = { authorization: `Bearer ${token}` };

    // No binary in the image needs a rebuild; a binary that's present but not answering is mid-boot or mid-restart and
    // just needs a moment.
    const unreachable = async (cause?: unknown): Promise<Error> =>
        (await binaryPresent())
            ? new Error("The model translator isn't answering yet: it may still be starting up. Try again in a moment.", { cause })
            : new Error(TRANSLATOR_BINARY_MISSING, { cause });

    // Every held subscription: read from the running proxy when up, else its auth-dir on disk. The disk fallback is the
    // difference between 'couldn't ask' and 'nothing there' while the proxy boots or restarts.
    const listFiles = async (): Promise<TranslatorAuthFile[]> => {
        const response = await fetchFn(`${managementUrl}/auth-files`, { headers: auth }).catch(() => undefined);
        if (response === undefined || !response.ok) {
            return authFilesOnDisk(authDir);
        }
        return ((await response.json()) as { files?: TranslatorAuthFile[] }).files ?? [];
    };

    // xAI/Kimi logins are device flows over the Management API: returns a verification URL and code, then polls to
    // completion in the background.
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

    // Google's redirect lands on a loopback port inside this container the user's browser can't reach, so it dead-ends
    // in their address bar; they paste that URL, and `complete` posts it back. No device flow exists for Google.
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

    // Hands a pasted redirect URL to the proxy, which matches it to the pending login and resumes the exchange;
    // surfaces the proxy's own rejection message.
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

    // Codex's Management API login can't complete remotely (browser redirect), so this drives `--codex-device-login` as
    // a subprocess, parsing its URL and code. A new connect kills the prior child.
    let codexChild: ChildProcess | undefined;
    const connectCodex = async (): Promise<TranslatorLogin> => {
        // Resolved before the executor so the login drives the same binary the supervised proxy does.
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
                    // The subprocess polls to completion itself; no handshake is left for the UI to resume.
                    resolve({ url, code, state: "", flow: "device" });
                }
            };
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("error", (error) => {
                if (!settled) {
                    settled = true;
                    // ENOENT means a core image with no cli-proxy-api; reported as the fixable, named error.
                    reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(TRANSLATOR_BINARY_MISSING) : error);
                }
            });
            child.on("exit", (exitCode) => {
                if (child === codexChild) {
                    codexChild = undefined;
                }
                // No code yet at exit: the flow failed. After: the poll finished; accounts has it.
                if (!settled) {
                    settled = true;
                    reject(new Error(`Codex device login exited (${exitCode}) before printing a code`));
                }
            });
        });
    };

    // Drops one account; the provider check stops a stale or cross-provider name from deleting the wrong credential. A
    // pending Codex login dies with any Codex disconnect, and the account's snapshot is dropped with it.
    const disconnect = async (provider: KeyedProvider, name: string): Promise<void> => {
        if (provider === "codex") {
            codexChild?.kill("SIGTERM");
            codexChild = undefined;
        }
        const cliproxyProvider = CLIPROXY_PROVIDER[provider];
        for (const file of await listFiles()) {
            if (file.provider === cliproxyProvider && file.name === name) {
                // The proxy owns the delete; unanswering means nothing happened, and must not report success.
                const response = await fetchFn(`${managementUrl}/auth-files?name=${encodeURIComponent(file.name)}`, {
                    method: "DELETE",
                    headers: auth,
                }).catch(async (err: unknown) => {
                    throw await unreachable(err);
                });
                if (!response.ok) {
                    throw new Error(`The translator refused to drop that account (${response.status}).`);
                }
            }
        }
    };

    // Readings live in the shared account-usage store, like a Claude account's, so a page load reads disk, not
    // upstream. A file needs `auth_index` (the proxy's handle) to count as readable.
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

    const headroom: HeadroomSource = {
        targets: async () =>
            readableFiles(await listFiles()).map((entry) => ({
                key: entry.key,
                provider: entry.provider,
                read: async () => ({
                    windows:
                        (
                            await fetchTranslatorUsage({
                                fetchFn,
                                managementUrl,
                                managementToken: token,
                                provider: entry.provider,
                                file: entry.file,
                            })
                        )?.windows ?? [],
                }),
            })),
    };

    // A provider's files, each paired with the proxy's current verdict and its recorded usage snapshot.
    const providerFiles = (files: readonly TranslatorAuthFile[], provider: KeyedProvider): (TranslatorAuthFile & { readonly name: string })[] =>
        files.flatMap((file) => (file.provider === CLIPROXY_PROVIDER[provider] && file.name !== undefined ? [{ ...file, name: file.name }] : []));

    // Read from recorded snapshots, not the refusal itself, since CLIProxyAPI's 429 is only the fleet's last word,
    // naming no account or reset. Errs early: a snapshot can miss an account that has since hit its wall.
    const turnLimit = async (provider: KeyedProvider, model: string): Promise<TurnLimit> => {
        const [files, stored] = await Promise.all([listFiles(), usageStore.read()]);
        return fleetLimit(
            providerFiles(files, provider).map((file) => ({
                account: file.name,
                usage: stored[usageKey(provider, file.name)],
                cooling: authFileCooling(file),
            })),
            { id: model },
        );
    };

    return {
        accounts: async () => {
            const [files, stored] = await Promise.all([listFiles(), usageStore.read()]);
            const of = (provider: KeyedProvider) =>
                providerFiles(files, provider).map((file) => {
                    const usage = stored[usageKey(provider, file.name)];
                    const cooling = authFileCooling(file);
                    return {
                        name: file.name,
                        label: file.email ?? file.label ?? file.name,
                        ...(usage === undefined ? {} : { usage }),
                        ...(cooling === undefined ? {} : { cooling }),
                    };
                });
            return { codex: of("codex"), grok: of("grok"), kimi: of("kimi"), gemini: of("gemini") };
        },
        headroom,
        sharedUsageKey: async (provider) => {
            const files = providerFiles(await listFiles(), provider);
            return files.length === 1 && files[0] !== undefined ? usageKey(provider, files[0].name) : undefined;
        },
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
