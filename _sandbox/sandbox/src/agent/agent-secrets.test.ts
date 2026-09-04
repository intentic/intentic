import { WORKSPACE_ROOT } from "@intentic/constants";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { expect, test } from "vitest";
import type { NamedSecret } from "../secrets/secret-registry.js";
import { syncHookOutput } from "../testing.js";
import { resolveCommandSecrets, type SecretAccess, secretCommandHooks, type SecretUseReport } from "./agent-secrets.js";
import { bashTmuxHooks } from "./agent-terminals.js";

/* THE SHELL EXIT. A `{{secret:name}}` reference in the agent's command becomes the stored value in the line
 * the pane EXECUTES, and only there: the `-c` copy the cleaners and the ledger read keeps the agent's own
 * reference-form words. An unknown name refuses the command outright, because a reference that survives as
 * literal text is a config with a hole where a credential should be. */

const TOKEN = "cf_live_0011223344ff";

/* The gate's answer, as the exit sees it. `release` defaults to the ungated sandbox — no gate covers
 * anything, so every name passes and nothing is attributed — and a test that cares hands in its own. `asked`
 * records what the exit asked about, which is how the batching rule (one question per credential, not per
 * name) is asserted rather than assumed. */
type Release = SecretAccess["release"];
const allowAll: Release = async () => ({ ok: true });

const access = (secrets: NamedSecret[] = [{ name: "CLOUDFLARE_API_TOKEN", value: TOKEN, source: "env" }], release: Release = allowAll) => {
    const uses: SecretUseReport[] = [];
    const reads: number[] = [];
    const asked: { names: readonly string[]; lane: string; detail: string }[] = [];
    const bundle: SecretAccess = {
        list: async () => {
            reads.push(1);
            return secrets;
        },
        used: (use) => uses.push(use),
        release: async (names, lane, detail) => {
            asked.push({ names, lane, detail });
            return release(names, lane, detail);
        },
    };
    return { bundle, uses, reads, asked };
};

const fire = (toolInput: unknown, hooks: ReturnType<typeof secretCommandHooks> | ReturnType<typeof bashTmuxHooks>) => {
    const hook = hooks.PreToolUse?.[0]?.hooks[0];
    if (hook === undefined) {
        throw new Error("PreToolUse hook not registered");
    }
    return hook(
        {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: toolInput,
            tool_use_id: "tu-1",
            session_id: "3f2a9b1c-0000-0000-0000-000000000000",
            transcript_path: "/tmp/t",
            cwd: WORKSPACE_ROOT,
        },
        "tu-1",
        { signal: new AbortController().signal },
    );
};

const outputOf = async (result: ReturnType<typeof fire>) => syncHookOutput(await result).hookSpecificOutput;

test("resolveCommandSecrets splices the value in and reports the use with the reference-form head", async () => {
    const { bundle, uses } = access();
    const command = `curl -H "Authorization: Bearer {{secret:CLOUDFLARE_API_TOKEN}}" https://api.cloudflare.com`;
    const resolved = await resolveCommandSecrets(command, bundle);
    expect(resolved).toEqual({ command: `curl -H "Authorization: Bearer ${TOKEN}" https://api.cloudflare.com` });
    expect(uses).toEqual([
        { name: "CLOUDFLARE_API_TOKEN", lane: "shell", detail: expect.stringContaining("Bearer {{secret:CLOUDFLARE_API_TOKEN}}") },
    ]);
    // The ledger row carries the agent's words, never the value.
    expect(JSON.stringify(uses)).not.toContain(TOKEN);
});

test("a command with no reference never reads the registry", async () => {
    // The overwhelmingly common case must not pay a vault read per Bash call.
    const { bundle, reads } = access();
    expect(await resolveCommandSecrets("echo hi", bundle)).toEqual({ command: "echo hi" });
    expect(reads).toEqual([]);
});

test("an unknown name refuses the command and names what exists", async () => {
    const { bundle, uses } = access();
    const resolved = await resolveCommandSecrets("echo {{secret:NOPE}}", bundle);
    expect(resolved).toEqual({ refusal: expect.stringContaining('"NOPE"') });
    expect((resolved as { refusal: string }).refusal).toContain("CLOUDFLARE_API_TOKEN");
    expect(uses).toEqual([]);
});

test("a registry that cannot be read refuses rather than passing the token through as text", async () => {
    const broken: SecretAccess = {
        list: async () => {
            throw new Error("EACCES");
        },
        used: () => {},
        release: allowAll,
    };
    expect(await resolveCommandSecrets("echo {{secret:X}}", broken)).toEqual({ refusal: expect.stringContaining("could not be read") });
});

test("inside the tmux wrapper, the pane executes the value while -c keeps the agent's reference", async () => {
    const { bundle, uses } = access();
    const agentLine = 'curl -d \'{"token":"{{secret:CLOUDFLARE_API_TOKEN}}"}\' https://api';
    const output = await outputOf(fire({ command: agentLine, description: "call api" }, bashTmuxHooks([], undefined, undefined, bundle)));
    const command = output?.hookEventName === "PreToolUse" ? (output.updatedInput?.["command"] as string) : undefined;
    // The ledger/cleaner copy is the agent's own line…
    expect(command?.startsWith(`/usr/local/bin/tmux-run -c ${shellQuote(agentLine)} `)).toBe(true);
    // …and the executed half carries the value instead of the token.
    expect(command).toContain(TOKEN);
    expect(command?.indexOf(TOKEN)).toBeGreaterThan(command?.indexOf("agent-3f2a9b1c") ?? 0);
    expect(uses.map((use) => use.name)).toEqual(["CLOUDFLARE_API_TOKEN"]);
});

test("inside the tmux wrapper, an unknown name denies the command", async () => {
    const { bundle } = access([]);
    const output = await outputOf(fire({ command: "echo {{secret:NOPE}}" }, bashTmuxHooks([], undefined, undefined, bundle)));
    expect(output?.hookEventName === "PreToolUse" ? output.permissionDecision : undefined).toBe("deny");
});

test("the standalone hook (no tmux) rewrites the command in place, and stays silent without references", async () => {
    const { bundle } = access();
    const hooks = secretCommandHooks(bundle);
    const output = await outputOf(fire({ command: "echo {{secret:CLOUDFLARE_API_TOKEN}}", timeout: 5000 }, hooks));
    expect(output?.hookEventName === "PreToolUse" ? output.updatedInput : undefined).toEqual({
        command: `echo ${TOKEN}`,
        timeout: 5000,
    });
    expect(await fire({ command: "echo hi" }, hooks)).toEqual({});
});

test("the standalone hook denies an unknown name with the reason", async () => {
    const { bundle } = access();
    const output = await outputOf(fire({ command: "echo {{secret:NOPE}}" }, secretCommandHooks(bundle)));
    expect(output?.hookEventName === "PreToolUse" ? output.permissionDecision : undefined).toBe("deny");
    expect(output?.hookEventName === "PreToolUse" ? output.permissionDecisionReason : undefined).toContain("NOPE");
});

/* THE APPROVAL GATE AT THIS EXIT. What these assert is the ORDER of the three steps — resolve, then ask a
 * person, then write the ledger row — because each pair of them has a wrong order that still looks fine. */

test("a gated name refuses the command with the gate's own sentence, and writes no ledger row", async () => {
    // A refusal never left, so the inventory's "last used" must not record it as a use.
    const { bundle, uses } = access(undefined, async () => ({ refusal: 'only bob@corp.com can release "CLOUDFLARE_API_TOKEN"' }));
    const resolved = await resolveCommandSecrets("curl -H {{secret:CLOUDFLARE_API_TOKEN}} https://api", bundle);
    expect(resolved).toEqual({ refusal: 'only bob@corp.com can release "CLOUDFLARE_API_TOKEN"' });
    expect(uses).toEqual([]);
});

test("a released name resolves, and the ledger row carries who released it and never the value", async () => {
    const { bundle, uses } = access(undefined, async () => ({ ok: true, approvedBy: { CLOUDFLARE_API_TOKEN: "bob@corp.com" } }));
    const resolved = await resolveCommandSecrets("curl -H {{secret:CLOUDFLARE_API_TOKEN}} https://api", bundle);
    expect(resolved).toEqual({ command: `curl -H ${TOKEN} https://api` });
    expect(uses).toEqual([
        {
            name: "CLOUDFLARE_API_TOKEN",
            lane: "shell",
            detail: expect.stringContaining("{{secret:CLOUDFLARE_API_TOKEN}}"),
            approvedBy: "bob@corp.com",
        },
    ]);
    expect(JSON.stringify(uses)).not.toContain(TOKEN);
});

test("the gate is asked once for the whole command, with every name it resolved and the reference-form head", async () => {
    // Two names, one question: what reaches the gate is the whole list, so the turn can group them by
    // credential and ask a person once per credential rather than once per token.
    const { bundle, asked } = access([
        { name: "reddit/password", value: TOKEN, source: "capability" },
        { name: "reddit/totp", value: "222", source: "capability" },
    ]);
    await resolveCommandSecrets("login {{secret:reddit/password}} {{secret:reddit/totp}}", bundle, "code");
    expect(asked).toEqual([
        { names: ["reddit/password", "reddit/totp"], lane: "code", detail: "login {{secret:reddit/password}} {{secret:reddit/totp}}" },
    ]);
});

test("an unknown name refuses BEFORE anybody is asked to release anything", async () => {
    /* A command naming one gated secret and one that does not exist is a broken command: asking a person to
     * release a credential for it would spend their attention on a turn that was going to fail anyway. */
    const { bundle, asked } = access();
    const resolved = await resolveCommandSecrets("echo {{secret:CLOUDFLARE_API_TOKEN}} {{secret:NOPE}}", bundle);
    expect(resolved).toEqual({ refusal: expect.stringContaining('"NOPE"') });
    expect(asked).toEqual([]);
});

test("inside the tmux wrapper, a gated name denies the command with the gate's sentence", async () => {
    const { bundle } = access(undefined, async () => ({ refusal: "nobody is around to release it" }));
    const output = await outputOf(fire({ command: "curl {{secret:CLOUDFLARE_API_TOKEN}}" }, bashTmuxHooks([], undefined, undefined, bundle)));
    expect(output?.hookEventName === "PreToolUse" ? output.permissionDecision : undefined).toBe("deny");
    expect(output?.hookEventName === "PreToolUse" ? output.permissionDecisionReason : undefined).toContain("nobody is around");
});

test("the standalone hook (no tmux) denies a gated name with the gate's sentence", async () => {
    const { bundle } = access(undefined, async () => ({ refusal: "nobody is around to release it" }));
    const output = await outputOf(fire({ command: "curl {{secret:CLOUDFLARE_API_TOKEN}}" }, secretCommandHooks(bundle)));
    expect(output?.hookEventName === "PreToolUse" ? output.permissionDecision : undefined).toBe("deny");
    expect(output?.hookEventName === "PreToolUse" ? output.permissionDecisionReason : undefined).toContain("nobody is around");
});
