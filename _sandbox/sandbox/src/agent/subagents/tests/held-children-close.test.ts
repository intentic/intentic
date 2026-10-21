import type { HookCallback, StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { HeldChild } from "../child-held.js";
import { syncHookOutput } from "../../run/harness/harness-hooks.testing.js";
import { heldChildrenHooks, heldChildrenNote } from "../held-children-close.js";

// What a parent is told as its turn stops with subagents' work still held off its checkout, and that it is told once.

const STOP: StopHookInput = { hook_event_name: "Stop", session_id: "s1", transcript_path: "s1.jsonl", cwd: ".", stop_hook_active: false };

const stopHook = (held: () => readonly HeldChild[]): HookCallback => {
    const hook = heldChildrenHooks(held).Stop?.[0]?.hooks[0];
    if (hook === undefined) {
        throw new Error("no Stop hook");
    }
    return hook;
};

const said = async (hook: HookCallback): Promise<string | undefined> => {
    const output = syncHookOutput(await hook(STOP, "t", { signal: new AbortController().signal })).hookSpecificOutput;
    return output?.hookEventName === "Stop" ? output.additionalContext : undefined;
};

describe("subagents' work a turn leaves held", () => {
    it("names each held child and the three honest ends for it", () => {
        const note = heldChildrenNote([
            { id: "sub-b", title: "Follow-up B" },
            { id: "sub-h2", title: undefined },
        ]);
        expect(note).toContain("2 subagents you started still hold work on their branches");
        expect(note).toContain('- sub-b ("Follow-up B")');
        expect(note).toContain("- sub-h2\n");
        expect(note).toContain("merge");
        expect(note).toContain("record that with settle");
        expect(note).toContain("say so plainly in your report");
    });

    it("is read as the turn stops, said once per turn, and not at all when nothing is held", async () => {
        let held: HeldChild[] = [];
        const hook = stopHook(() => held);
        held = [{ id: "sub-b", title: "Follow-up B" }];
        await expect(said(hook)).resolves.toContain("A subagent you started still holds work on its branch");
        await expect(said(hook)).resolves.toBeUndefined();
        await expect(said(stopHook(() => []))).resolves.toBeUndefined();
    });

    it("wires nothing for a turn that may not supervise children", () => {
        expect(heldChildrenHooks(undefined)).toEqual({});
    });
});
