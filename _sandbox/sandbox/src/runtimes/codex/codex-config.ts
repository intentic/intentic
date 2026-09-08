import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Codex CLI config for the sandbox's single CODEX_HOME. Every turn authenticates via the bundled translator on the
// subscription, or the container's OPENAI_API_KEY with no translator. Writes config.toml: privacy hardening, plus a
// translator model_provider (CODEX_API_KEY bearer, no websockets).

// Privacy hardening: analytics, feedback, and the startup update probe (image-pinned CLI) have no env var, only
// config.toml keys at $CODEX_HOME.
const privacyConfig = (translatorSelected: boolean): string =>
    [
        `check_for_update_on_startup = false`,
        // Default provider for every turn; a per-turn adapter override still wins (codex-agent.ts).
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

// translator model_provider block: Responses wire format at the translator's endpoint, authed by a fixed bearer
// (CODEX_API_KEY) that never rotates, so nothing races the translator's own refresh.
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

// Full config.toml for the codex home. translatorUrl empty means no translator baked; Codex uses its default OpenAI
// provider on OPENAI_API_KEY.
export const codexConfigToml = (translatorUrl: string): string =>
    `${privacyConfig(translatorUrl !== "")}${translatorUrl !== "" ? translatorProviderBlock(translatorUrl) : ""}\n`;

// Writes the codex home's config.toml, overwriting whole: the daemon owns this one home, so it's always current; no
// per-account homes.
export const writeCodexConfig = async (home: string, translatorUrl: string): Promise<void> => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.toml"), codexConfigToml(translatorUrl), { mode: 0o600 });
};
