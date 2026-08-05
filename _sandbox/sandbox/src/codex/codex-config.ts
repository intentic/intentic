import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/* Codex CLI config for the sandbox's single CODEX_HOME. Codex has no sandbox-owned OAuth: every Codex turn —
 * the codex provider adapter and the Claude agent's shell delegation — authenticates through the bundled
 * translator (CLIProxyAPI) on the user's ChatGPT SUBSCRIPTION, or the container's OPENAI_API_KEY on a bare dev
 * run with no translator. This module writes that home's config.toml: privacy hardening plus, when a translator
 * is baked, the `translator` model_provider pointed at its OpenAI-compatible endpoint (the bearer rides
 * CODEX_API_KEY via env_key; supports_websockets=false because the translator's inbound is plain POST SSE). */

// Privacy hardening: Codex has no telemetry env vars — analytics (chatgpt.com events, whose flag also gates the
// default statsig metrics exporter), the Sentry-backed /feedback flow, and the startup update probe (the CLI is
// image-pinned) are all config.toml keys at the user level $CODEX_HOME.
const privacyConfig = (translatorSelected: boolean): string =>
    [
        `check_for_update_on_startup = false`,
        // The default provider for every turn (and the agent's freeform `codex exec` in delegation, which can't
        // pass per-invocation overrides): the translator on the subscription. A per-turn adapter override still
        // wins for the primary provider path (codex-agent.ts), so this line is what serves shell delegation.
        ...(translatorSelected ? [`model_provider = "translator"`] : []),
        ``,
        `[analytics]`,
        `enabled = false`,
        ``,
        `[feedback]`,
        `enabled = false`,
        ``,
        `[otel]`,
        `metrics_exporter = "none"`,
    ].join("\n");

// The `translator` model_provider block: Codex's own Responses wire format pointed at the translator's
// OpenAI-compatible endpoint, authed by the fixed local bearer (env_key → CODEX_API_KEY, which never rotates,
// so nothing races the translator's own subscription refresh).
const translatorProviderBlock = (translatorUrl: string): string =>
    [
        ``,
        `[model_providers.translator]`,
        `name = "translator"`,
        `base_url = "${translatorUrl.replace(/\/$/, "")}/v1"`,
        `wire_api = "responses"`,
        `env_key = "CODEX_API_KEY"`,
        `supports_websockets = false`,
    ].join("\n");

// The full config.toml for the codex home. `translatorUrl` empty ⇒ no translator baked (dev): Codex uses its
// default OpenAI provider on OPENAI_API_KEY.
export const codexConfigToml = (translatorUrl: string): string =>
    `${privacyConfig(translatorUrl !== "")}${translatorUrl !== "" ? translatorProviderBlock(translatorUrl) : ""}\n`;

// Write the codex home's config.toml. Authoritative (overwrites): the daemon owns this single home, so the
// translator provider + privacy config are always current — no per-account homes, no migration (assume fresh).
export const writeCodexConfig = async (home: string, translatorUrl: string): Promise<void> => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.toml"), codexConfigToml(translatorUrl), { mode: 0o600 });
};
