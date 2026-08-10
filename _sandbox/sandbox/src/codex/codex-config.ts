import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/* Codex CLI config for the sandbox's single CODEX_HOME. Codex has no sandbox-owned OAuth: every Codex turn —
 * the codex provider adapter and the Claude agent's shell delegation — authenticates through the bundled
 * translator (CLIProxyAPI) on the user's ChatGPT SUBSCRIPTION, or the container's OPENAI_API_KEY on a bare dev
 * run with no translator. This module writes that home's config.toml: privacy hardening plus, when a translator
 * is baked, the `translator` model_provider pointed at its OpenAI-compatible endpoint (the bearer rides
 * CODEX_API_KEY via env_key; supports_websockets=false because the translator's inbound is plain POST SSE).
 *
 * It also writes the home's HOOKS — the authoritative status feed for delegated `codex exec` runs. Codex's
 * hooks are Claude-shaped (hooks.json beside config.toml, PascalCase event names, nested command entries) and
 * gated twice: `[features] hooks = true` turns the engine on, and each INVOCATION must still carry
 * `--dangerously-bypass-hook-trust`, because trust is only persistable through Codex's interactive TUI — which
 * a headless sandbox never runs. The delegation note carries the flag (agent/delegation.ts); the "danger" it
 * waives is running an unvetted hook, and this hook's author is the daemon itself. Any codex run WITHOUT the
 * flag (the user's own, the native adapter's) skips hooks silently, which is exactly the right default. */

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
        ``,
        // The hook engine's on-switch — inert on its own; see the trust-bypass half in the header.
        `[features]`,
        `hooks = true`,
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

const HOOK_SCRIPT_NAME = "intentic-signals.sh";

/* The hook itself: one JSON line per event into the daemon's signal spool, stamped with the delegation id the
 * Bash rewrite put into the pane environment (agent/agent-terminals.ts). No stamp — not a delegation — is the
 * first exit: the native adapter's and the user's own codex runs owe the roster nothing, so they cost one env
 * test. Write-then-rename because the spool watcher may list the directory mid-write; every failure path exits
 * 0, because a reporting hook must never be the reason a delegated run fails. */
export const codexSignalScript = (spoolDir: string): string =>
    [
        `#!/bin/sh`,
        `# managed by intentic — overwritten on daemon boot (src/codex/codex-config.ts).`,
        `# Reports a delegated codex run's lifecycle into the daemon's signal spool, where it is folded into`,
        `# the subagent roster (src/agent/delegation-signals.ts).`,
        `set -u`,
        `[ -n "\${INTENTIC_DELEGATION_ID:-}" ] || exit 0`,
        `payload=$(cat 2>/dev/null) || payload=""`,
        `[ -n "$payload" ] || payload=null`,
        `dir='${spoolDir}'`,
        `mkdir -p "$dir" 2>/dev/null || exit 0`,
        `tmp=$(mktemp "$dir/.sig.XXXXXX" 2>/dev/null) || exit 0`,
        `printf '{"source":"codex","action":"%s","delegationId":"%s","payload":%s}\\n' "\${1:-}" "$INTENTIC_DELEGATION_ID" "$payload" >"$tmp" 2>/dev/null || { rm -f "$tmp"; exit 0; }`,
        `mv -f "$tmp" "$dir/sig-$$-$(date +%s%N 2>/dev/null || date +%s).json" 2>/dev/null || rm -f "$tmp"`,
        `exit 0`,
    ].join("\n") + "\n";

// One event entry in codex's hooks.json — the Claude-nested shape (matcher-less group → command hooks),
// verified against codex 0.146: PascalCase event keys under a top-level `hooks` object; snake_case keys are
// silently ignored, and an unknown TOP-level key is a parse error ("expected `description` or `hooks`").
const hookEntry = (scriptPath: string, action: string): unknown[] => [
    { hooks: [{ type: "command", command: `sh '${scriptPath}' ${action}`, timeout: 10 }] },
];

/* Which events feed the roster, mapped to the spool's own verbs. Stop carries `last_assistant_message` — the
 * delegate's report, for free — and PermissionRequest is the `blocked` a parent waits on. PostToolUse is left
 * out: PreToolUse already flips a blocked child back to running on the approval's next tool run, and a busy
 * codex turn fires tool hooks constantly — half the spool churn for the same signal. SessionEnd is left out
 * too (codex clamps its timeout to 3s, and the settle paths own the ending). */
const HOOK_EVENTS: readonly { readonly event: string; readonly action: string }[] = [
    { event: "SessionStart", action: "session" },
    { event: "UserPromptSubmit", action: "working" },
    { event: "PreToolUse", action: "working" },
    { event: "PermissionRequest", action: "blocked" },
    { event: "Stop", action: "report" },
];

export const codexHooksJson = (scriptPath: string): string =>
    `${JSON.stringify(
        {
            description: "managed by intentic — rebuilding or restarting the daemon overwrites this file",
            hooks: Object.fromEntries(HOOK_EVENTS.map(({ event, action }) => [event, hookEntry(scriptPath, action)])),
        },
        undefined,
        4,
    )}\n`;

// Write the codex home's config.toml, hooks.json and the signal hook they point at. Authoritative (overwrites):
// the daemon owns this single home, so the translator provider + privacy config + hooks are always current —
// no per-account homes, no migration (assume fresh).
export const writeCodexConfig = async (home: string, translatorUrl: string, signalSpoolDir: string): Promise<void> => {
    await mkdir(home, { recursive: true });
    const scriptPath = join(home, HOOK_SCRIPT_NAME);
    await Promise.all([
        writeFile(join(home, "config.toml"), codexConfigToml(translatorUrl), { mode: 0o600 }),
        writeFile(scriptPath, codexSignalScript(signalSpoolDir), { mode: 0o755 }),
        writeFile(join(home, "hooks.json"), codexHooksJson(scriptPath), { mode: 0o644 }),
    ]);
};
