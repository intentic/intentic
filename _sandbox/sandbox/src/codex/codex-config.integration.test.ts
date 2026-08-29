import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { codexConfigToml, writeCodexConfig } from "./codex-config.js";

test("with a translator baked, the config selects the translator provider on the local-bearer Responses endpoint", () => {
    const toml = codexConfigToml("http://127.0.0.1:8788");
    expect(toml).toContain(`model_provider = "translator"`);
    expect(toml).toContain(`[model_providers.translator]`);
    expect(toml).toContain(`base_url = "http://127.0.0.1:8788/v1"`);
    expect(toml).toContain(`wire_api = "responses"`);
    expect(toml).toContain(`env_key = "CODEX_API_KEY"`);
    // Load-bearing: the translator's inbound is plain POST SSE, so Codex must not attempt its WebSocket transport.
    expect(toml).toContain(`supports_websockets = false`);
    // Privacy hardening rides along.
    expect(toml).toContain(`enabled = false`);
});

test("with no translator (dev), the config selects no provider: Codex uses its OPENAI_API_KEY default", () => {
    const toml = codexConfigToml("");
    expect(toml).not.toContain(`model_provider`);
    expect(toml).not.toContain(`model_providers`);
    expect(toml).toContain(`check_for_update_on_startup = false`);
});

test("writeCodexConfig writes the home's config.toml", async () => {
    const home = join(await mkdtemp(join(tmpdir(), "codex-home-")), "codex");
    await writeCodexConfig(home, "http://127.0.0.1:8788");
    expect(await readFile(join(home, "config.toml"), "utf8")).toContain(`base_url = "http://127.0.0.1:8788/v1"`);
});
