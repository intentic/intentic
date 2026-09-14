import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { readTaskStore, type StoredTask, taskStoreDir } from "./task-store.js";

/* THE LIST A TURN IS ABOUT TO LEAVE OPEN, said back to it once at Stop. */

// Enough of the list to act on; a long list is named by its count, not re-pasted.
const NAMED_ITEMS = 5;

export interface ChecklistCloseDeps {
    // The tree whose `.intentic/records` holds the store; absent (a bench run, a hand-built request) wires no hook.
    readonly workspaceRoot: string | undefined;
    // Injected for tests; the real read is the seed's own (task-store.ts).
    readonly read?: ((dir: string) => Promise<readonly StoredTask[]>) | undefined;
}

const itemLine = (task: StoredTask): string => `- #${task.id} ${task.subject}${task.status === "in_progress" ? " (in progress)" : ""}`;

// The sentence: what is open, the three honest ways to close each, and why it matters, in that order.
export const checklistCloseNote = (open: readonly StoredTask[]): string => {
    const named = open.slice(0, NAMED_ITEMS).map(itemLine);
    const rest = open.length - named.length;
    return [
        `Your task list still has ${open.length} open ${open.length === 1 ? "item" : "items"}:`,
        ...named,
        ...(rest > 0 ? [`- … +${rest} more`] : []),
        `Before you stop, settle each one: finish it if it is still yours to do now; mark it completed (TaskUpdate) if the work is already done; ` +
            `delete it (TaskUpdate with status "deleted") if it no longer applies. If you are stopping short on purpose, leave it open and say so plainly. ` +
            `The board reads this list to tell a finished session from one that stopped short, so an item left open is read as work not done.`,
    ].join("\n");
};

// The one Stop matcher, wired beside the owner's turn.ending rules (agent.ts mergeHooks) and independent of them: this
// is the harness's own bookkeeping, not a rule the owner stood, so it neither counts against their follow-up rounds
// nor waits on any standing here.
export const checklistCloseHooks = (deps: ChecklistCloseDeps): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const root = deps.workspaceRoot;
    if (root === undefined) {
        return {};
    }
    const read = deps.read ?? readTaskStore;
    // Once per turn; a closure per turn, like every other memory in this hook set.
    let asked = false;
    return {
        Stop: [
            {
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "Stop" || asked) {
                            return {};
                        }
                        // An unreadable store contributes nothing, like the seed it is read for; never a failed Stop.
                        const tasks = await read(taskStoreDir(root, input.session_id)).catch((): readonly StoredTask[] => []);
                        const open = tasks.filter((task) => task.status !== "completed");
                        if (open.length === 0) {
                            return {};
                        }
                        asked = true;
                        return { hookSpecificOutput: { hookEventName: "Stop", additionalContext: checklistCloseNote(open) } };
                    },
                ],
            },
        ],
    };
};
