import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { SecretAccess } from "../../secrets/secret-access.js";
import { codexAllowlistConfig, codexHooksConfig, codexListName, createCodexHookSession, patchFiles } from "./codex-hooks.js";
import { maskScript } from "./codex-mask-script.js";

// What a Codex thread's hooks ask the door's gate, and what this run does with the gate's answer.

const PATCH = ["*** Begin Patch", "*** Add File: notes.md", "+hi", "*** Update File: src/a.ts", "*** Move to: src/b.ts", "@@", "*** Delete File: old.ts", "*** End Patch"].join("\n");

const secretsOf = (stored: Readonly<Record<string, string>>): SecretAccess => ({
    list: async () => Object.entries(stored).map(([name, value]) => ({ name, value, source: "sandbox" as const })),
    used: () => {},
    release: async () => ({ ok: true }),
});

test("the hooks name only fields Codex always sends, carry the key, and leave Stop out while planning", () => {
    const executing = codexHooksConfig("k-1", false);
    expect(Object.keys(executing).toSorted()).toEqual(["bypass_hook_trust", "hooks.PostToolUse", "hooks.PreToolUse", "hooks.Stop"]);
    expect(executing["hooks.PreToolUse"]).toEqual([
        {
            hooks: [
                {
                    type: "mcp_tool",
                    server: "gate",
                    tool: "pre_tool_use",
                    input: { tool_name: "${tool_name}", tool_input: "${tool_input}", cwd: "${cwd}", tool_use_id: "${tool_use_id}", session_id: "${session_id}", key: "k-1" },
                    // Longer than any card waits: a hook that times out lets its call through.
                    timeout: 30 * 24 * 3_600,
                },
            ],
        },
    ]);
    expect(Object.keys(codexHooksConfig("k-1", true))).not.toContain("hooks.Stop");
});

test("a patch reads as the files it adds, changes and deletes, and as Write only when it just adds", () => {
    expect(patchFiles({ command: PATCH })).toEqual({ added: ["notes.md"], changed: ["src/a.ts", "src/b.ts"], deleted: ["old.ts"] });
    expect(codexListName({ tool: "apply_patch", input: { command: PATCH } })).toBe("Edit");
    expect(codexListName({ tool: "apply_patch", input: { command: "*** Begin Patch\n*** Add File: x.md\n+x\n*** End Patch" } })).toBe("Write");
    expect(codexListName({ tool: "Bash", input: { command: "ls" } })).toBe("Bash");
    expect(codexListName({ tool: "mcp__browser__browser_snapshot", input: {} })).toBe("mcp__browser__browser_snapshot");
});

test("no list changes nothing; a list keeps a whole server it names whole and the shell it names at all", () => {
    expect(codexAllowlistConfig(undefined, ["browser"])).toEqual({});
    const config = codexAllowlistConfig(["Read", "Bash", "mcp__browser"], ["browser", "gate"]);
    expect(config).toEqual({ web_search: "disabled", "features.image_generation": false, "features.multi_agent": false, "tools.experimental_request_user_input.enabled": false });
    expect(codexAllowlistConfig([], ["browser"])).toMatchObject({ "features.shell_tool": false, "features.view_image": false, "mcp_servers.browser.enabled_tools": [] });
});

describe("a run's side of the gate", () => {
    const options = (secrets?: SecretAccess, push: (event: AgentEvent) => void = () => {}) => ({
        cwd: WORKSPACE_ROOT,
        tools: secrets === undefined ? {} : { secrets },
        push,
        terminals: false,
    });

    test("records each answer by call id, and refuses what the policy refused", async () => {
        const session = createCodexHookSession(options());
        const settle = session.gateHooks.settle;
        expect(await settle?.({ tool: "apply_patch", input: { command: PATCH }, id: "p1" }, { decision: "allow" }, true)).toEqual({ decision: "allow" });
        expect(await settle?.({ tool: "Bash", input: { command: "rm -rf /" }, id: "c1" }, { decision: "deny", reason: "no" }, false)).toEqual({ decision: "deny", reason: "no" });
        expect(session.record("p1")).toEqual({ allowed: true, asked: true });
        expect(session.record("c1")).toEqual({ allowed: false, asked: false });
        expect(session.record("never")).toBeUndefined();
        // The model calling the gate's own tools is refused, whatever the policy said.
        expect(await settle?.({ tool: "mcp__gate__stop", input: {}, id: "g1" }, { decision: "allow" }, false)).toMatchObject({ decision: "deny" });
        await session.dispose();
    });

    test("a command with stored secrets runs under the mask, its references resolved out of sight, the model's words kept", async () => {
        const session = createCodexHookSession(options(secretsOf({ API_TOKEN: "tok-0123456789abcdef" })));
        const verdict = await session.gateHooks.settle?.({ tool: "Bash", input: { command: "curl -H 'x: {{secret:API_TOKEN}}' x" }, id: "c1" }, { decision: "allow" }, false);
        expect(verdict).toEqual({ decision: "rewrite", input: { command: expect.stringMatching(/^node '?\S+intentic-codex-mask\.mjs'? '?\S+\.json'?$/u) } });
        expect(JSON.stringify(verdict)).not.toContain("tok-0123456789abcdef");
        expect(session.record("c1")).toEqual({ allowed: true, asked: false, said: "curl -H 'x: {{secret:API_TOKEN}}' x" });
        expect(session.gateHooks.original?.({ tool: "Bash", input: { command: "node …" }, id: "c1" })).toEqual({ command: "curl -H 'x: {{secret:API_TOKEN}}' x" });
        await session.dispose();
    });

    test("a reference to a secret nobody stored refuses the command; with nothing stored no wrapper is needed", async () => {
        const stored = createCodexHookSession(options(secretsOf({ API_TOKEN: "tok-0123456789abcdef" })));
        const refused = await stored.gateHooks.settle?.({ tool: "Bash", input: { command: "echo {{secret:NOPE}}" }, id: "c2" }, { decision: "allow" }, false);
        expect(refused).toMatchObject({ decision: "deny", reason: expect.stringContaining('no stored secret named "NOPE"') });
        expect(stored.record("c2")?.allowed).toBe(false);
        await stored.dispose();

        const empty = createCodexHookSession(options(secretsOf({})));
        expect(await empty.gateHooks.settle?.({ tool: "Bash", input: { command: "ls" }, id: "c3" }, { decision: "allow" }, false)).toEqual({ decision: "allow" });
        await empty.dispose();
    });

    test("an unreadable secret store refuses the command, since its output could not be masked", async () => {
        const broken: SecretAccess = { ...secretsOf({}), list: async () => { throw new Error("store gone"); } };
        const session = createCodexHookSession(options(broken));
        expect(await session.gateHooks.settle?.({ tool: "Bash", input: { command: "ls" }, id: "c4" }, { decision: "allow" }, false)).toMatchObject({ decision: "deny" });
        await session.dispose();
    });

    test("a patch's added and changed files go to the edit checks, and their findings come back", async () => {
        const seen: string[] = [];
        const session = createCodexHookSession({
            ...options(),
            editReviewers: [
                async (file, how) => {
                    seen.push(`${file} (${how})`);
                    return file.endsWith("b.ts") ? "src/b.ts: 1 error" : undefined;
                },
            ],
        });
        expect(await session.gateHooks.afterTool?.({ tool: "apply_patch", input: { command: PATCH }, id: "p1" })).toBe("src/b.ts: 1 error");
        expect(seen).toEqual([`${WORKSPACE_ROOT}/notes.md (this edit)`, `${WORKSPACE_ROOT}/src/a.ts (this edit)`, `${WORKSPACE_ROOT}/src/b.ts (this edit)`]);
        expect(await session.gateHooks.afterTool?.({ tool: "Bash", input: { command: "ls" }, id: "c1" })).toBeUndefined();
        await session.dispose();
    });
});

// The wrapper Codex runs, under node as Codex would run it: a stored value in the output reads as its reference, even
// split across two writes, and the command's exit status is its own.
test("the mask script prints the command's output with stored values as their references", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mask-test-"));
    try {
        const script = join(dir, "mask.mjs");
        writeFileSync(script, maskScript());
        const spec = join(dir, "spec.json");
        const value = "tok-0123456789abcdef";
        writeFileSync(
            spec,
            JSON.stringify({
                command: `printf 'a ${value.slice(0, 7)}'; sleep 0.2; printf '${value.slice(7)} b\\n'; echo "err ${value}" >&2; exit 3`,
                targets: [{ target: value, replacement: "{{secret:API_TOKEN}}" }],
            }),
        );
        const run = spawnSync("node", [script, spec], { encoding: "utf8" });
        expect(run.stdout).toBe("a {{secret:API_TOKEN}} b\n");
        expect(run.stderr).toBe("err {{secret:API_TOKEN}}\n");
        expect(run.status).toBe(3);
        // The spec, which held the values, is gone once read.
        expect(readdirSync(dir)).toEqual(["mask.mjs"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
