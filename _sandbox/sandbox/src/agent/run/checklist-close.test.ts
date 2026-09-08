import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { syncHookOutput } from "../../testing.js";
import { checklistCloseHooks, checklistCloseNote } from "./checklist-close.js";
import type { StoredTask } from "./task-store.js";
import { taskStoreDir } from "./task-store.js";

// The one Stop-time ask about a checklist the turn is leaving open: said once, off the CLI's own store for the session
// the Stop names, and only when something on it is not completed.

const ROOT = WORKSPACE_ROOT;

const stored = (...rows: [string, StoredTask["status"], string][]): StoredTask[] => rows.map(([id, status, subject]) => ({ id, status, subject }));

// Drives the hook the way the SDK does; the store is a function of the directory asked for, so a wrong session id
// reads as an empty list rather than as the right one.
const armed = (store: Record<string, readonly StoredTask[]>) => {
    const asked: string[] = [];
    const hooks = checklistCloseHooks({
        workspaceRoot: ROOT,
        read: async (dir) => {
            asked.push(dir);
            return store[dir] ?? [];
        },
    });
    const stop = async (session_id = "s1"): Promise<string | undefined> => {
        const input = { hook_event_name: "Stop", session_id, stop_hook_active: false } as unknown as HookInput;
        const result = await hooks.Stop![0]!.hooks[0]!(input, "t", { signal: new AbortController().signal });
        return (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
    };
    return { stop, asked };
};

describe("checklistCloseHooks", () => {
    it("names what is still open, and the three ways to settle each, once", async () => {
        const { stop } = armed({
            [taskStoreDir(ROOT, "s1")]: stored(
                ["1", "completed", "Map the install"],
                ["3", "pending", "Restore reachability"],
                ["5", "in_progress", "Finalize"],
            ),
        });
        const note = await stop();
        expect(note).toBe(checklistCloseNote(stored(["3", "pending", "Restore reachability"], ["5", "in_progress", "Finalize"])));
        expect(note).toContain("2 open items:");
        expect(note).toContain("- #3 Restore reachability\n- #5 Finalize (in progress)");
        expect(note).toContain('delete it (TaskUpdate with status "deleted")');
        expect(note).toContain("leave it open and say so plainly");
        // The second Stop is the agent's answer, whatever it did with the list; asking again would be the loop.
        expect(await stop()).toBeUndefined();
    });

    it("says nothing for a list the turn closed", async () => {
        const { stop } = armed({ [taskStoreDir(ROOT, "s1")]: stored(["1", "completed", "Map the install"], ["2", "completed", "Fix it"]) });
        expect(await stop()).toBeUndefined();
    });

    it("says nothing for a turn that kept no list", async () => {
        const { stop, asked } = armed({});
        expect(await stop()).toBeUndefined();
        expect(asked).toEqual([taskStoreDir(ROOT, "s1")]);
    });

    // The store is per session; the Stop names which, and a fresh session's ids begin again, so last session's list is
    // not this turn's to close.
    it("reads the store of the session the Stop names, not another's", async () => {
        const { stop } = armed({ [taskStoreDir(ROOT, "old")]: stored(["3", "pending", "Restore reachability"]) });
        expect(await stop("new")).toBeUndefined();
    });

    // Never a failed Stop: an unreadable store contributes nothing, like the seed it is read for.
    it("treats a store it cannot read as empty", async () => {
        const hooks = checklistCloseHooks({
            workspaceRoot: ROOT,
            read: async () => {
                throw new Error("EACCES");
            },
        });
        const input = { hook_event_name: "Stop", session_id: "s1", stop_hook_active: false } as unknown as HookInput;
        expect(await hooks.Stop![0]!.hooks[0]!(input, "t", { signal: new AbortController().signal })).toEqual({});
    });

    it("wires nothing without a tree to read the store under", () => {
        expect(checklistCloseHooks({ workspaceRoot: undefined })).toEqual({});
    });

    it("counts a long list rather than re-pasting it", () => {
        const many = stored(
            ...Array.from({ length: 8 }, (_, index): [string, StoredTask["status"], string] => [`${index + 1}`, "pending", `Step ${index + 1}`]),
        );
        const note = checklistCloseNote(many);
        expect(note).toContain("8 open items:");
        expect(note).toContain("- #5 Step 5\n- … +3 more");
        expect(note).not.toContain("Step 6");
    });

    it("says one item in the singular", () => {
        expect(checklistCloseNote(stored(["4", "pending", "Run the suite"]))).toContain("1 open item:");
    });
});
