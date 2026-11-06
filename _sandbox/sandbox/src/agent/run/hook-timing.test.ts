import type { HookCallback, HookEvent, PostToolUseHookInput, PreToolUseHookInput, StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { currentGitCaller, withGitCaller, withGitCallerPart } from "@intentic/base/git";
import { type HookTiming, namedHook, namedHooks, timedHooks } from "./hook-timing.js";

// Every hook callback of a turn, timed into the perf log: what it answers is untouched, a throw still throws and is still
// timed, and a turn with nowhere to report keeps its hooks as they were.

const BASE = { session_id: "s1", transcript_path: "s1.jsonl", cwd: "." };
const PRE: PreToolUseHookInput = { ...BASE, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "t1" };
const STOP: StopHookInput = { ...BASE, hook_event_name: "Stop", stop_hook_active: false };
const POST: PostToolUseHookInput = { ...BASE, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: {}, tool_use_id: "t1" };
const OPTIONS = { signal: new AbortController().signal };
const ANSWER = { continue: true };

interface Heard {
    readonly event: HookEvent;
    readonly ms: number;
    readonly timing: HookTiming;
}

const recorder = () => {
    const heard: Heard[] = [];
    return { heard, record: (event: HookEvent, ms: number, timing: HookTiming) => void heard.push({ event, ms, timing }) };
};

test("each callback answers as before and is reported with its event, matcher, place and tool", async () => {
    const hook: HookCallback = async () => ANSWER;
    const { heard, record } = recorder();
    const hooks = timedHooks({ PreToolUse: [{ hooks: [hook] }, { matcher: "Edit", hooks: [hook] }] }, record);
    const [first, second] = hooks.PreToolUse ?? [];
    expect(await first?.hooks[0]?.(PRE, "t1", OPTIONS)).toBe(ANSWER);
    expect(await second?.hooks[0]?.(PRE, "t1", OPTIONS)).toBe(ANSWER);
    expect(second?.matcher).toBe("Edit");
    expect(heard.map(({ event, timing }) => ({ event, timing }))).toEqual([
        { event: "PreToolUse", timing: { matcher: "*", at: 0, tool: "Bash" } },
        { event: "PreToolUse", timing: { matcher: "Edit", at: 1, tool: "Bash" } },
    ]);
    expect(heard.every(({ ms }) => ms >= 0)).toBe(true);
});

test("a callback that throws still throws, and its time is still reported", async () => {
    const hook: HookCallback = async () => {
        throw new Error("hook broke");
    };
    const { heard, record } = recorder();
    const [matcher] = timedHooks({ Stop: [{ hooks: [hook] }] }, record).Stop ?? [];
    await expect(matcher?.hooks[0]?.(STOP, undefined, OPTIONS)).rejects.toThrow("hook broke");
    expect(heard.map(({ event, timing }) => ({ event, timing }))).toEqual([{ event: "Stop", timing: { matcher: "*", at: 0, tool: undefined } }]);
});

test("with nowhere to report, the hooks are handed back untouched", () => {
    const hooks = { PostToolUse: [{ hooks: [async () => ANSWER] }] };
    expect(timedHooks(hooks, undefined)).toBe(hooks);
});

// The git a hook runs is counted by what issued it (gitRunCallers): its event and the name its set joined the turn under,
// inside the entry that started the turn, so a route's total still adds up. A callback named where it was written keeps
// its own name inside a named set, and one never named is still told apart by its event.
test("each callback's git is filed under its event and name inside the turn's entry", async () => {
    const heardAs: (string | undefined)[] = [];
    const listen: HookCallback = async () => {
        heardAs.push(currentGitCaller());
        return ANSWER;
    };
    const ownName = namedHook("shell-edits", async () => listen(POST, "t1", OPTIONS));
    const hooks = timedHooks(
        {
            ...namedHooks("main-catch-up", { PostToolUse: [{ hooks: [listen] }, { matcher: "Bash", hooks: [ownName] }] }),
            Stop: [{ hooks: [async () => listen(STOP, undefined, OPTIONS)] }],
        },
        recorder().record,
    );
    const [catchUp, shell] = hooks.PostToolUse ?? [];
    const [stop] = hooks.Stop ?? [];
    await withGitCaller("http agent.run", () =>
        withGitCallerPart("turn", async () => {
            await catchUp?.hooks[0]?.(POST, "t1", OPTIONS);
            await shell?.hooks[0]?.(POST, "t1", OPTIONS);
            await stop?.hooks[0]?.(STOP, undefined, OPTIONS);
        }),
    );
    expect(heardAs).toEqual([
        "http agent.run › turn.hook.PostToolUse:main-catch-up",
        "http agent.run › turn.hook.PostToolUse:shell-edits",
        "http agent.run › turn.hook.Stop",
    ]);
});
