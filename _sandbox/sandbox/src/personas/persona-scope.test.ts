import type { HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { type Persona, PersonaPowersSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { personaScopeHooks, personaScopeOf } from "./persona-scope.js";
import { turnPersona } from "./personas.js";

const ROOT = "/work";

const scopeFor = (extra: Partial<Persona>) =>
    personaScopeOf(turnPersona({ personas: [{ id: "card", capabilities: [], ...extra }], actsAs: "card", unattended: true }), ROOT);

// Drive the PreToolUse hook the way the SDK does, and answer with the refusal reason or undefined for "allowed".
const attempt = async (
    hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
    tool: string,
    input: Record<string, unknown>,
): Promise<string | undefined> => {
    const hook = hooks.PreToolUse?.[0]?.hooks[0];
    if (hook === undefined) {
        throw new Error("no PreToolUse hook was wired");
    }
    const result = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input } as unknown as HookInput, undefined, {
        signal: new AbortController().signal,
    });
    const output = (result as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
    return output?.permissionDecision === "deny" ? output.permissionDecisionReason : undefined;
};

/* A workspace that has never set a folder limit must wire no hook at all: the cost of a feature nobody uses
 * should be zero, and this is the check that keeps it that way. */
test("a card with no folder limit and full sandbox access asks for no scope", () => {
    expect(scopeFor({})).toBeUndefined();
});

test("a file tool inside the allowed folders is untouched", async () => {
    const scope = scopeFor({ workspace: { folders: ["apps/web"] } });
    const hooks = personaScopeHooks(scope!);
    expect(await attempt(hooks, "Read", { file_path: "/work/apps/web/src/main.ts" })).toBeUndefined();
    // Relative paths resolve against the turn's own root, exactly as the tool would resolve them.
    expect(await attempt(hooks, "Edit", { file_path: "apps/web/package.json" })).toBeUndefined();
});

test("a file tool outside them is refused, and told where it may work", async () => {
    const hooks = personaScopeHooks(scopeFor({ workspace: { folders: ["apps/web"] } })!);
    const reason = await attempt(hooks, "Write", { file_path: "/work/apps/api/secret.ts" });
    expect(reason).toContain("apps/web");
    expect(reason).toContain("apps/api/secret.ts");
});

/* The prefix-vs-path trap: `apps/web2` is not inside `apps/web`, however much it looks like it from a string
 * comparison. Getting this wrong grants a whole sibling repo. */
test("a sibling folder sharing a prefix is not inside the limit", async () => {
    const hooks = personaScopeHooks(scopeFor({ workspace: { folders: ["apps/web"] } })!);
    expect(await attempt(hooks, "Read", { file_path: "/work/apps/web2/main.ts" })).toBeDefined();
});

/* Paths outside the workspace are a different question, answered by the container. Judging them here would
 * refuse an attachment the user just uploaded and read to the agent as a broken tool. */
test("a path outside the workspace entirely is not this setting's business", async () => {
    const hooks = personaScopeHooks(scopeFor({ workspace: { folders: ["apps/web"] } })!);
    expect(await attempt(hooks, "Read", { file_path: "/tmp/scratch.txt" })).toBeUndefined();
});

// Glob and Grep search the cwd when given no path, which is inside the scope by construction.
test("a search tool with no path is left alone", async () => {
    const hooks = personaScopeHooks(scopeFor({ workspace: { folders: ["apps/web"] } })!);
    expect(await attempt(hooks, "Grep", { pattern: "todo" })).toBeUndefined();
});

// ── "Change the sandbox" ────────────────────────────────────────────────────────────────────────────────────

test("a card that may not change the sandbox is refused its config and its public outbox", async () => {
    const hooks = personaScopeHooks(scopeFor({ powers: PersonaPowersSchema.parse({ sandbox: false }) })!);
    expect(await attempt(hooks, "Write", { file_path: "/work/.intentic/config/settings.json" })).toContain("sandbox's own configuration");
    expect(await attempt(hooks, "Edit", { file_path: "/work/public/leak.txt" })).toContain("sandbox's own configuration");
    // Ordinary workspace files are untouched: this switch is about the sandbox, not about editing at all.
    expect(await attempt(hooks, "Write", { file_path: "/work/apps/web/main.ts" })).toBeUndefined();
});

/* READING the sandbox's own config stays allowed. An agent reads .intentic to answer questions about itself all
 * day, and refusing that would break far more than it protects: the switch is "change", not "know about". */
test("reading the sandbox's own config is still allowed", async () => {
    const hooks = personaScopeHooks(scopeFor({ powers: PersonaPowersSchema.parse({ sandbox: false }) })!);
    expect(await attempt(hooks, "Read", { file_path: "/work/.intentic/config/settings.json" })).toBeUndefined();
});
