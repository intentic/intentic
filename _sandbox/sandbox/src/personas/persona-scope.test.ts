import type { HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { type Fence, type Persona, PersonaPowersSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { personaScopeHooks, personaScopeOf } from "./persona-scope.js";
import { turnPersona } from "./personas.js";

const ROOT = "/work";

// `fence` is what the conversation was born with (its starter's own); undefined is an unfenced member.
const scopeFor = (extra: Partial<Persona>, fence?: Fence) =>
    personaScopeOf(turnPersona({ personas: [{ id: "support", capabilities: [], ...extra }], actsAs: "support", unattended: true, fence }), ROOT);

// Drives the PreToolUse hook like the SDK does; returns the refusal reason, or undefined for allowed.
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

test("a persona with no folder limit and full sandbox access asks for no scope", () => {
    expect(scopeFor({})).toBeUndefined();
});

test("a file tool inside the allowed folders is untouched", async () => {
    const scope = scopeFor({ workspace: { folders: ["apps/web"] } });
    const hooks = personaScopeHooks(scope!);
    expect(await attempt(hooks, "Read", { file_path: "/work/apps/web/src/main.ts" })).toBeUndefined();
    // Relative paths resolve against the turn's own root, like the tool itself would resolve them.
    expect(await attempt(hooks, "Edit", { file_path: "apps/web/package.json" })).toBeUndefined();
});

test("a file tool outside them is refused, and told where it may work", async () => {
    const hooks = personaScopeHooks(scopeFor({ workspace: { folders: ["apps/web"] } })!);
    const reason = await attempt(hooks, "Write", { file_path: "/work/apps/api/secret.ts" });
    expect(reason).toContain("apps/web");
    expect(reason).toContain("apps/api/secret.ts");
});

// `apps/web2` is not inside `apps/web`, however alike the strings look; a naive prefix check would grant a sibling
// repo.
test("a sibling folder sharing a prefix is not inside the limit", async () => {
    const hooks = personaScopeHooks(scopeFor({ workspace: { folders: ["apps/web"] } })!);
    expect(await attempt(hooks, "Read", { file_path: "/work/apps/web2/main.ts" })).toEqual(expect.any(String));
});

// Out-of-workspace paths are a different question, answered by the container, not this setting.
test("a path outside the workspace entirely is not this setting's business", async () => {
    const hooks = personaScopeHooks(scopeFor({ workspace: { folders: ["apps/web"] } })!);
    expect(await attempt(hooks, "Read", { file_path: "/tmp/scratch.txt" })).toBeUndefined();
});

// Glob/Grep search the cwd when given no path, which is inside scope by construction.
test("a search tool with no path is left alone", async () => {
    const hooks = personaScopeHooks(scopeFor({ workspace: { folders: ["apps/web"] } })!);
    expect(await attempt(hooks, "Grep", { pattern: "todo" })).toBeUndefined();
});

// The fence a conversation inherits from whoever started it

// A persona that names no folder used to mean "the whole workspace"; it now means "whatever the starter could see",
// which is the whole point of inheritance — a fenced person cannot ask an unfenced persona to fetch a file for them.
test("a persona naming no folder is still bounded by the fence its conversation was born with", async () => {
    const scope = scopeFor({}, ["apps/web"]);
    const hooks = personaScopeHooks(scope!);
    expect(await attempt(hooks, "Read", { file_path: "/work/apps/web/src/main.ts" })).toBeUndefined();
    expect(await attempt(hooks, "Read", { file_path: "/work/apps/api/secret.ts" })).toContain("apps/web");
});

test("a persona's folders narrow the conversation's fence and can never widen it", async () => {
    // The persona asks for all of `apps`; the conversation was started by someone who only holds `apps/web`.
    const hooks = personaScopeHooks(scopeFor({ workspace: { folders: ["apps"] } }, ["apps/web"])!);
    expect(await attempt(hooks, "Read", { file_path: "/work/apps/web/main.ts" })).toBeUndefined();
    expect(await attempt(hooks, "Read", { file_path: "/work/apps/api/main.ts" })).toEqual(expect.any(String));
});

// A member granted areas that resolve to no folder (every one deleted, or an area file that will not parse) reaches
// nothing. Fail-shut: the empty list is a real fence, not the absence of one.
test("a fence that resolves to no folder admits nothing rather than everything", async () => {
    const hooks = personaScopeHooks(scopeFor({}, [])!);
    expect(await attempt(hooks, "Read", { file_path: "/work/apps/web/main.ts" })).toContain("no folder of this workspace");
});

// "Change the sandbox"

test("a persona that may not change the sandbox is refused its config and its public outbox", async () => {
    const hooks = personaScopeHooks(scopeFor({ powers: PersonaPowersSchema.parse({ sandbox: false }) })!);
    expect(await attempt(hooks, "Write", { file_path: "/work/.intentic/config/settings.json" })).toContain("sandbox's own configuration");
    expect(await attempt(hooks, "Edit", { file_path: "/work/public/leak.txt" })).toContain("sandbox's own configuration");
    // Ordinary workspace files are untouched; the switch is about the sandbox, not about editing in general.
    expect(await attempt(hooks, "Write", { file_path: "/work/apps/web/main.ts" })).toBeUndefined();
});

// The switch is "change", not "know about"; blocking reads would break routine self-inspection.
test("reading the sandbox's own config is still allowed", async () => {
    const hooks = personaScopeHooks(scopeFor({ powers: PersonaPowersSchema.parse({ sandbox: false }) })!);
    expect(await attempt(hooks, "Read", { file_path: "/work/.intentic/config/settings.json" })).toBeUndefined();
});
