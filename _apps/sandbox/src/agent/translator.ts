import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Services } from "../composition.js";
import { resolveProviderKey } from "./provider-keys.js";

/* The bundled Anthropic↔OpenAI translator: a LiteLLM proxy that lets the Claude Code harness — which speaks only
 * the Anthropic Messages API — drive OpenAI (Codex) and xAI (Grok) models. A routed turn (streamAgent) points the
 * Claude Code SDK at config.translator.url with config.translator.token as the bearer; LiteLLM maps the incoming
 * model id to its provider + upstream API key (from the provider-keys store, container-env key as fallback).
 *
 * LiteLLM is a Python proxy baked into the sandbox image (see the Dockerfile). On a bare `tsx watch` dev run
 * TRANSLATOR_URL is empty and this is a no-op — routed turns then surface streamAgent's clean "no translator"
 * error. The proxy restarts when the keys file changes so an in-app key add/remove takes effect without a daemon
 * restart. ponytail: gpt-5-codex may require OpenAI's Responses wire API; if LiteLLM routes it via chat/completions
 * and OpenAI rejects it, pin the wire api in the model entry (litellm docs) — isolated to renderConfig below. */

// The model ids the daemon's routedModel() sends → LiteLLM provider-prefixed model + which stored key feeds it.
const MODEL_ROUTES: Record<string, { litellm: string; provider: "codex" | "grok" }> = {
    "gpt-5-codex": { litellm: "openai/gpt-5-codex", provider: "codex" },
    "grok-4": { litellm: "xai/grok-4", provider: "grok" },
};

const renderConfig = (entries: readonly { modelName: string; litellm: string; key: string }[], masterKey: string): string => {
    const models = entries
        .map((entry) => `  - model_name: ${entry.modelName}\n    litellm_params:\n      model: ${entry.litellm}\n      api_key: ${JSON.stringify(entry.key)}`)
        .join("\n");
    // An empty model_list is valid — LiteLLM starts with no models and the watcher restarts it once a key lands.
    return `model_list:\n${models}\ngeneral_settings:\n  master_key: ${JSON.stringify(masterKey)}\n`;
};

const portOf = (url: string): number | undefined => {
    try {
        const parsed = new URL(url);
        return parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    } catch {
        return undefined;
    }
};

// Start the translator proxy and keep it converged with the stored provider keys. Best-effort and non-throwing:
// a routed turn that finds it down surfaces its own error. Returns immediately; the proxy runs for the daemon's
// lifetime. No-op when no translator is baked (config.translator.url empty — the dev path).
export const startTranslator = (services: Services): void => {
    const { config, providerKeys, logger } = services;
    if (config.translator.url === "") {
        return;
    }
    const port = portOf(config.translator.url);
    if (port === undefined) {
        logger.warn({ url: config.translator.url }, "translator: unparseable TRANSLATOR_URL — not starting");
        return;
    }
    const configPath = join(config.historyRoot, "translator", "config.yaml");
    const keysDir = join(services.workspace.root, ".intentic");
    let child: ChildProcess | undefined;
    let restarting = false;

    const buildEntries = async (): Promise<{ modelName: string; litellm: string; key: string }[]> => {
        const entries: { modelName: string; litellm: string; key: string }[] = [];
        for (const [modelName, { litellm, provider }] of Object.entries(MODEL_ROUTES)) {
            const key = await resolveProviderKey(providerKeys, config, provider);
            if (key !== undefined) {
                entries.push({ modelName, litellm, key });
            }
        }
        return entries;
    };

    const start = async (): Promise<void> => {
        const entries = await buildEntries();
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, renderConfig(entries, config.translator.token), { mode: 0o600 });
        child = spawn("litellm", ["--config", configPath, "--host", "127.0.0.1", "--port", String(port)], { stdio: "ignore", env: process.env });
        child.on("exit", (code) => {
            child = undefined;
            if (restarting) {
                return;
            }
            logger.warn({ code }, "translator: litellm exited — restarting in 5s");
            setTimeout(() => void start().catch((error: unknown) => logger.warn({ err: error }, "translator restart failed")), 5_000);
        });
    };

    const restart = async (): Promise<void> => {
        restarting = true;
        child?.kill("SIGTERM");
        child = undefined;
        await start();
        restarting = false;
    };

    void start().catch((error: unknown) => logger.warn({ err: error }, "translator: initial start failed"));

    // Reload on a key change so an in-app key add/remove takes effect on the next routed turn without a restart.
    void mkdir(keysDir, { recursive: true })
        .then(() => {
            watch(keysDir, (_event, filename) => {
                if (filename === "provider-keys.json") {
                    void restart().catch((error: unknown) => logger.warn({ err: error }, "translator: key-change reload failed"));
                }
            });
        })
        .catch((error: unknown) => logger.warn({ err: error }, "translator: key watch not established — restart the sandbox after adding a key"));
};
