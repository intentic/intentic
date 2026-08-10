import { readFile, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { codexConfigToml, codexHooksJson, codexSignalScript, writeCodexConfig } from "./codex-config.js";

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

test("with no translator (dev), the config selects no provider — Codex uses its OPENAI_API_KEY default", () => {
    const toml = codexConfigToml("");
    expect(toml).not.toContain(`model_provider`);
    expect(toml).not.toContain(`model_providers`);
    expect(toml).toContain(`check_for_update_on_startup = false`);
});

test("the hook engine's feature flag is on with and without a translator — the trust bypass gates actual runs", () => {
    expect(codexConfigToml("http://127.0.0.1:8788")).toContain(`[features]\nhooks = true`);
    expect(codexConfigToml("")).toContain(`[features]\nhooks = true`);
});

/* The shape codex 0.146 actually parses, pinned by a live probe: PascalCase event keys under a top-level
 * `hooks` object (snake_case keys are silently ignored — the failure mode is no events, not an error), and an
 * unknown top-level key is a parse failure. A regression here is invisible at runtime, so the test is the
 * guard. */
test("hooks.json carries the roster's five events in codex's own shape", () => {
    const parsed = JSON.parse(codexHooksJson("/agent-auth/codex/intentic-signals.sh")) as {
        hooks: Record<string, [{ hooks: [{ type: string; command: string; timeout: number }] }]>;
    };
    expect(Object.keys(parsed.hooks)).toStrictEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop"]);
    expect(parsed.hooks["SessionStart"]?.[0]?.hooks[0]?.command).toBe("sh '/agent-auth/codex/intentic-signals.sh' session");
    expect(parsed.hooks["PermissionRequest"]?.[0]?.hooks[0]?.command).toBe("sh '/agent-auth/codex/intentic-signals.sh' blocked");
    expect(parsed.hooks["Stop"]?.[0]?.hooks[0]?.command).toBe("sh '/agent-auth/codex/intentic-signals.sh' report");
});

test("the signal script reports only delegations, into the given spool, and can never fail its caller", () => {
    const script = codexSignalScript("/tmp/intentic/agent-signals");
    // The first exit: no delegation stamp, nothing to report — the native adapter's and the user's own runs.
    expect(script).toContain(`[ -n "\${INTENTIC_DELEGATION_ID:-}" ] || exit 0`);
    expect(script).toContain(`dir='/tmp/intentic/agent-signals'`);
    // Write-then-rename, so the watcher never reads a half-written file.
    expect(script).toContain(`mktemp`);
    expect(script).toContain(`mv -f`);
    // A reporting hook must never be the reason a delegated run fails.
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
});

test("writeCodexConfig writes the home whole: config, hooks, and an executable signal script", async () => {
    const home = join(await mkdtemp(join(tmpdir(), "codex-home-")), "codex");
    await writeCodexConfig(home, "http://127.0.0.1:8788", "/tmp/intentic/agent-signals");
    expect(await readFile(join(home, "config.toml"), "utf8")).toContain(`base_url = "http://127.0.0.1:8788/v1"`);
    const hooks = JSON.parse(await readFile(join(home, "hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
    // hooks.json points at the script beside it, and that script is executable.
    expect(JSON.stringify(hooks.hooks["Stop"])).toContain(join(home, "intentic-signals.sh"));
    expect(((await stat(join(home, "intentic-signals.sh"))).mode & 0o111) !== 0).toBe(true);
});
