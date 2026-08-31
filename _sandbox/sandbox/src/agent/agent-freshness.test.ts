import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import type { Freshness, FreshnessResolver, PinnedPackage } from "../dependencies/registry-freshness.js";
import type { WorkspacePins } from "../dependencies/workspace-pins.js";
import { syncHookOutput } from "../testing.js";
import { freshnessHooks, namesAddedByCommand, pinsInCommand, pinsInManifest, splitRange } from "./agent-freshness.js";

// A registry that answers for exactly the packages named, and counts how often it is asked: not re-asking is
// half of what makes this affordable to run in front of a tool call.
const registry = (answers: Record<string, Freshness>, asks: { count: number } = { count: 0 }): { resolve: FreshnessResolver; asks: { count: number } } => ({
    resolve: async (pinned: PinnedPackage) => {
        asks.count += 1;
        return answers[pinned.name];
    },
    asks,
});

const behind = (latest: string, gap: Freshness["gap"] = "minor"): Freshness => ({ latest, gap });

const fire = async (
    hooks: ReturnType<typeof freshnessHooks>,
    event: "PreToolUse" | "PostToolUse",
    tool_input: unknown,
    tool_name = "Bash",
): Promise<ReturnType<typeof syncHookOutput> | undefined> => {
    const matchers = event === "PreToolUse" ? hooks.PreToolUse : hooks.PostToolUse;
    if (matchers === undefined) {
        return undefined;
    }
    const input = { hook_event_name: event, tool_name, tool_input, tool_response: {}, tool_use_id: "t1" } as unknown as HookInput;
    return syncHookOutput(await matchers[0]!.hooks[0]!(input, "t1", { signal: new AbortController().signal }));
};

const context = (result: Awaited<ReturnType<typeof fire>>): string | undefined =>
    (result?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

/* ---- what counts as a version decision -------------------------------------------------------------- */

test("a manifest's own version field is not a dependency, which was the loudest false positive when measured", () => {
    const body = JSON.stringify({ name: "app", version: "1.4.0", dependencies: { vue: "3.5.22" } });
    expect(pinsInManifest("/work/app/package.json", body).map((pin) => pin.name)).toEqual(["vue"]);
});

test("workspace, catalog and file specifiers are left alone: no registry has them", () => {
    const body = JSON.stringify({
        dependencies: { "@intentic/base": "workspace:*", vue: "catalog:", local: "file:../local", real: "1.2.3" },
    });
    expect(pinsInManifest("/work/app/package.json", body).map((pin) => pin.name)).toEqual(["real"]);
});

test("a nested object inside a dependency block cannot leak its keys in", () => {
    const body = `{"dependencies":{"vue":"3.5.22"},"exports":{"./thing":{"types":"9.9.9"}}}`;
    expect(pinsInManifest("/work/app/package.json", body).map((pin) => pin.name)).toEqual(["vue"]);
});

test.each([
    ["pnpm add @types/vscode@1.90.0", "@types/vscode", "1.90.0"],
    ["npm install -g @openai/codex@0.147.0", "@openai/codex", "0.147.0"],
    ["pnpm add -D vitest@2.0.0", "vitest", "2.0.0"],
])("an install command's pin is read, scope and flags included: %s", (command, name, version) => {
    expect(pinsInCommand(command)).toEqual([{ ecosystem: "npm", name, version, range: "" }]);
});

test("pip and cargo spell a pin their own way and are read too", () => {
    expect(pinsInCommand("pip install requests==2.20.0")).toEqual([{ ecosystem: "pypi", name: "requests", version: "2.20.0", range: "" }]);
    expect(pinsInCommand("cargo add serde@1.0.100")).toEqual([{ ecosystem: "crates", name: "serde", version: "1.0.100", range: "" }]);
});

test("a command that installs nothing named pins nothing", () => {
    expect(pinsInCommand("pnpm install")).toEqual([]);
    expect(pinsInCommand("pnpm test")).toEqual([]);
});

test("an unversioned add still names the package, which is what a successor remark needs", () => {
    expect(namesAddedByCommand("pnpm add moment")).toEqual([{ ecosystem: "npm", name: "moment" }]);
});

test.each([
    ["^1.2.3", "^", "1.2.3"],
    ["~1.2.3", "~", "1.2.3"],
    ["1.2.3", "", "1.2.3"],
    [">=1.2.3", ">=", "1.2.3"],
])("a range operator is kept, because it decides what behind even means: %s", (specifier, range, version) => {
    expect(splitRange(specifier)).toEqual({ range, version });
});

test.each(["*", "latest", "^1.x", "github:vuejs/vue"])("a specifier with no readable version is left alone: %s", (specifier) => {
    expect(splitRange(specifier)).toBeUndefined();
});

/* ---- the hook ---------------------------------------------------------------------------------------- */

test("off wires no hook at all, so a workspace that has not asked for this pays nothing", () => {
    expect(freshnessHooks("off", registry({}).resolve)).toEqual({});
    expect(freshnessHooks(undefined, registry({}).resolve)).toEqual({});
    expect(freshnessHooks("versions", undefined)).toEqual({});
});

test("a pin the registry has moved past is reported, with both versions named", async () => {
    const { resolve } = registry({ "@types/vscode": behind("1.125.0") });
    const said = context(await fire(freshnessHooks("versions", resolve), "PreToolUse", { command: "pnpm add @types/vscode@1.90.0" }));
    expect(said).toContain("@types/vscode");
    expect(said).toContain("1.90.0");
    expect(said).toContain("1.125.0");
});

/* THE SENTENCE THAT KEEPS THIS FROM CHURNING A HEALTHY MANIFEST. Matching a version the workspace already
 * pins is the commonest reason to write something other than the newest, and it is a GOOD one; without this
 * the notice reads as "newer is better" and earns a diff nobody wanted. */
test("the notice names the good reasons to keep an older version", async () => {
    const { resolve } = registry({ vue: behind("3.5.41") });
    const said = context(await fire(freshnessHooks("versions", resolve), "PreToolUse", { command: "pnpm add vue@3.5.22" }));
    expect(said).toMatch(/already.*memory/i);
});

test("a resolver with nothing to say produces no notice", async () => {
    const { resolve } = registry({});
    expect(await fire(freshnessHooks("versions", resolve), "PreToolUse", { command: "pnpm add vue@3.5.22" })).toEqual({});
});

test("a resolver that throws is a resolver that said nothing, never the agent's problem", async () => {
    const throwing: FreshnessResolver = async () => {
        throw new Error("registry down");
    };
    expect(await fire(freshnessHooks("versions", throwing), "PreToolUse", { command: "pnpm add vue@3.5.22" })).toEqual({});
});

test("a file that is not a manifest is never scanned", async () => {
    const { resolve, asks } = registry({ vue: behind("3.5.41") });
    await fire(freshnessHooks("versions", resolve), "PreToolUse", { file_path: "/work/app/src/main.ts", content: `"vue": "3.5.22"` }, "Write");
    expect(asks.count).toBe(0);
});

test("a package is named once per turn, however many times the file is edited", async () => {
    const { resolve } = registry({ vue: behind("3.5.41") });
    const hooks = freshnessHooks("versions", resolve);
    const body = JSON.stringify({ dependencies: { vue: "3.5.22" } });
    expect(context(await fire(hooks, "PreToolUse", { file_path: "/work/app/package.json", content: body }, "Write"))).toContain("vue");
    expect(await fire(hooks, "PreToolUse", { file_path: "/work/app/package.json", content: body }, "Write")).toEqual({});
});

/* The catch-up pass. A cold lookup cannot be waited for in front of the call, so the same question is asked
 * again after it — and the `told` set is what stops that from repeating whatever the first pass said. */
test("the PostToolUse pass reports what was too cold to answer before the call, and never repeats it", async () => {
    let ready = false;
    const resolve: FreshnessResolver = async () => (ready ? behind("0.151.0") : undefined);
    const hooks = freshnessHooks("versions", resolve);
    const call = { command: "pnpm add @openai/codex@0.147.0" };
    expect(await fire(hooks, "PreToolUse", call)).toEqual({});
    ready = true;
    expect(context(await fire(hooks, "PostToolUse", call))).toContain("0.151.0");
    expect(await fire(hooks, "PostToolUse", call)).toEqual({});
});

/* ---- what the workspace already pins ------------------------------------------------------------------
 *
 * The largest source of "behind" versions in the measured history was also the most legitimate one: a new
 * package inside a monorepo taking the version the rest of the tree uses. Reporting those would put the whole
 * catalog on screen every time somebody scaffolded a package, and is how this gets switched off. */

const pins = (index: Record<string, string[]>): WorkspacePins => (ecosystem, name) => new Set(ecosystem === "npm" ? (index[name] ?? []) : []);

test("a version this workspace already uses is a decision it has made, not a stale pin", async () => {
    const { resolve, asks } = registry({ typescript: behind("7.0.2", "major") });
    const hooks = freshnessHooks("versions", resolve, pins({ typescript: ["5.9.3"] }));
    const body = JSON.stringify({ devDependencies: { typescript: "5.9.3" } });
    expect(await fire(hooks, "PreToolUse", { file_path: "/work/new-pkg/package.json", content: body }, "Write")).toEqual({});
    // Suppressed BEFORE the lookup, so the quiet case costs no request either.
    expect(asks.count).toBe(0);
});

test("a package the workspace has no opinion about is still reported", async () => {
    const { resolve } = registry({ "@types/vscode": behind("1.125.0") });
    const hooks = freshnessHooks("versions", resolve, pins({ typescript: ["5.9.3"] }));
    const body = JSON.stringify({ devDependencies: { "@types/vscode": "1.90.0" } });
    expect(context(await fire(hooks, "PreToolUse", { file_path: "/work/vscode/package.json", content: body }, "Write"))).toContain("1.125.0");
});

test("a DIFFERENT version of a package the workspace pins is still reported", async () => {
    const { resolve } = registry({ typescript: behind("7.0.2", "major") });
    const hooks = freshnessHooks("versions", resolve, pins({ typescript: ["5.9.3"] }));
    const body = JSON.stringify({ devDependencies: { typescript: "4.1.0" } });
    expect(context(await fire(hooks, "PreToolUse", { file_path: "/work/new-pkg/package.json", content: body }, "Write"))).toContain("typescript");
});

/* ---- successors -------------------------------------------------------------------------------------- */

test("versions mode never names a successor, however abandoned the package is", async () => {
    const { resolve } = registry({ request: { latest: "2.88.2", gap: "patch", deprecated: "request has been deprecated" } });
    const said = context(await fire(freshnessHooks("versions", resolve), "PreToolUse", { command: "pnpm add request@2.88.2" }));
    expect(said).toContain("deprecated");
    expect(said).not.toContain("undici");
});

test("full mode names the replacement for an abandoned package, once the registry has corroborated it", async () => {
    const { resolve } = registry({ request: { latest: "2.88.2", gap: "patch", deprecated: "request has been deprecated" } });
    expect(context(await fire(freshnessHooks("full", resolve), "PreToolUse", { command: "pnpm add request@2.88.2" }))).toContain("undici");
});

/* The bar that keeps the curated list from rotting silently: the daemon refuses to call something abandoned
 * on the list's say-so alone. An entry that stops being true stops being said. */
test("an abandoned entry stays silent when the registry does not corroborate it", async () => {
    const { resolve } = registry({ request: behind("3.0.0") });
    expect(context(await fire(freshnessHooks("full", resolve), "PreToolUse", { command: "pnpm add request@2.88.2" }))).not.toContain("undici");
});

test("a superseded remark is made when the package is being added, where the choice is actually live", async () => {
    const { resolve } = registry({});
    expect(context(await fire(freshnessHooks("full", resolve), "PreToolUse", { command: "pnpm add moment" }))).toContain("date-fns");
});

/* A suggestion has no lookup behind it, so filing it under "checked against the registry" would be a small lie
 * — and the advice about taking the newer version means nothing when no version was in question. */
test("a suggestion on its own never claims a registry was consulted", async () => {
    const { resolve } = registry({});
    const said = context(await fire(freshnessHooks("full", resolve), "PreToolUse", { command: "pnpm add moment" }));
    expect(said).not.toMatch(/checked against the registry|Take the newer version/i);
    expect(said).toMatch(/lookup/i);
});

test("when both have something to say they stay two sections", async () => {
    const { resolve } = registry({ moment: behind("2.30.1") });
    const said = context(await fire(freshnessHooks("full", resolve), "PreToolUse", { command: "pnpm add moment@2.29.4" }));
    expect(said).toMatch(/checked against the registry/i);
    expect(said).toContain("date-fns");
});

/* Second-guessing a dependency the project already committed to is noise, and would be this feature's
 * fastest route to being switched off. A manifest is not the moment of the choice. */
test("a superseded remark is never made about a version already sitting in a manifest", async () => {
    const { resolve } = registry({});
    const body = JSON.stringify({ dependencies: { moment: "2.29.4" } });
    expect(await fire(freshnessHooks("full", resolve), "PreToolUse", { file_path: "/work/app/package.json", content: body }, "Write")).toEqual({});
});
