import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { ProbeHit, ProbeOptions, RgSearch } from "@intentic/text-search";
import type { IsolationPlan, TurnPlacement } from "../../conversations/worktrees/isolation.js";
import { syncHookOutput } from "../run/harness/harness-hooks.testing.js";
import { searchProbeHooks, type SearchProbe } from "./search-probe-hooks.js";

// When an empty Grep is probed, in whose names, and what the agent is told; the probes themselves run against real rg in
// text-search's own suite and in search-probe-hooks.integration.test.ts.

const PLAN: IsolationPlan = {
    worktree: `${HISTORY_ROOT}/worktrees/c1`,
    root: WORKSPACE_ROOT,
    mirrors: [],
    overlays: `${HISTORY_ROOT}/overlays/c1`,
    fence: undefined,
};
const IN_NAMESPACE: TurnPlacement = { plan: PLAN, anchor: { pid: 4321, cwd: WORKSPACE_ROOT, plan: PLAN, dispose: () => {} } };
const NO_NAMESPACE: TurnPlacement = { plan: PLAN };

const EMPTY = { mode: "files_with_matches", numFiles: 0, filenames: [] };

// A probe that records what it was asked and answers `hits`.
const recording = (hits: ProbeHit[]) => {
    const asked: { search: RgSearch; options: ProbeOptions }[] = [];
    const probe: SearchProbe = async (search, options) => {
        asked.push({ search, options });
        return hits;
    };
    return { asked, probe };
};

const CASE_HIT: ProbeHit = { kind: "case", files: 2, more: false, examples: ["src/a.ts", "src/b.ts"] };

const grep = async (hooks: ReturnType<typeof searchProbeHooks>, toolInput: unknown, toolResponse: unknown, cwd = `${WORKSPACE_ROOT}/intentic`) => {
    const [matcher] = hooks.PostToolUse ?? [];
    const input: PostToolUseHookInput = {
        hook_event_name: "PostToolUse",
        tool_name: "Grep",
        tool_input: toolInput,
        tool_response: toolResponse,
        tool_use_id: "t1",
        session_id: "",
        transcript_path: "",
        cwd,
    };
    const output = syncHookOutput((await matcher?.hooks[0]?.(input, "t1", { signal: new AbortController().signal })) ?? {});
    const specific = output.hookSpecificOutput;
    return specific?.hookEventName === "PostToolUse" ? specific.additionalContext : undefined;
};

test("an empty Grep is probed as rg reads it and told in Grep's own switches", async () => {
    const { asked, probe } = recording([CASE_HIT, { kind: "ignored", files: 1, more: true, examples: ["dist/x.js"] }]);
    const said = await grep(searchProbeHooks(undefined, probe), { pattern: "fooBar", path: "src", glob: "*.ts,*.tsx", type: "ts", "-i": false }, EMPTY);
    expect(said).toBe(
        'no matches. Would match: case-insensitive ("-i": true) → 2 files (src/a.ts, src/b.ts); ' +
            "in gitignored files, which Grep skips (rg -u in Bash searches them) → 1+ files (dist/x.js, …)",
    );
    const [{ search } = { search: undefined }] = asked;
    expect(search).toMatchObject({ cwd: `${WORKSPACE_ROOT}/intentic`, pattern: "fooBar", paths: [`${WORKSPACE_ROOT}/intentic/src`], hidden: true, ignoreCase: false });
    // Grep's own exclusions, then its type and each glob as it splits them.
    expect(search?.flags?.slice(-6)).toEqual(["--type", "ts", "--glob", "*.ts", "--glob", "*.tsx"]);
    expect(search?.flags).toContain("!.git");
});

test("a Grep that found something, ran out of time, or paged past its end is not probed", async () => {
    const { asked, probe } = recording([CASE_HIT]);
    const hooks = searchProbeHooks(undefined, probe);
    expect(await grep(hooks, { pattern: "x" }, { mode: "files_with_matches", numFiles: 1, filenames: ["a.ts"] })).toBeUndefined();
    expect(await grep(hooks, { pattern: "x" }, { mode: "content", numFiles: 0, filenames: [], content: "a.ts:1:x" })).toBeUndefined();
    expect(await grep(hooks, { pattern: "x" }, { ...EMPTY, timedOut: true })).toBeUndefined();
    expect(await grep(hooks, { pattern: "x", offset: 20 }, EMPTY)).toBeUndefined();
    expect(await grep(hooks, { pattern: "x" }, "Found 3 files")).toBeUndefined();
    expect(asked).toEqual([]);
    // A rendered answer saying nothing was found is probed like the structured one.
    expect(await grep(hooks, { pattern: "x" }, "No files found")).toContain("case-insensitive");
});

test("nothing any probe finds is nothing said", async () => {
    expect(await grep(searchProbeHooks(undefined, recording([]).probe), { pattern: "absent" }, EMPTY)).toBeUndefined();
});

test("an isolated turn without a namespace is probed in its worktree and told in its own names", async () => {
    const { asked, probe } = recording([{ kind: "ignored", files: 1, more: false, examples: [`${PLAN.worktree}/intentic/dist/x.js`] }]);
    const said = await grep(searchProbeHooks(NO_NAMESPACE, probe), { pattern: "x", path: `${WORKSPACE_ROOT}/intentic/dist` }, EMPTY);
    expect(asked[0]?.search.cwd).toBe(`${PLAN.worktree}/intentic`);
    expect(asked[0]?.search.paths).toEqual([`${PLAN.worktree}/intentic/dist`]);
    expect(asked[0]?.options.enter).toBeUndefined();
    expect(said).toContain(`(${WORKSPACE_ROOT}/intentic/dist/x.js)`);
    expect(said).not.toContain(PLAN.worktree);
});

test("a turn with a namespace has its probe enter it and asked in the agent's names", async () => {
    const { asked, probe } = recording([]);
    await grep(searchProbeHooks(IN_NAMESPACE, probe), { pattern: "x", path: "src" }, EMPTY);
    expect(asked[0]?.search.paths).toEqual([`${WORKSPACE_ROOT}/intentic/src`]);
    const entered = asked[0]?.options.enter?.("rg", ["-l"]);
    expect(entered?.command).toBe("nsenter");
    expect(entered?.args).toContain(`--wdns=${WORKSPACE_ROOT}/intentic`);
    expect(entered?.args.slice(-2)).toEqual(["rg", "-l"]);
});
