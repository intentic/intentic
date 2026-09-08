import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { readTaskStore, type StoredTask, taskStoreDir } from "./task-store.js";

/* THE LIST A TURN IS ABOUT TO LEAVE OPEN, said back to it once at Stop. The board reads the agent's own checklist to
 * tell a finished session from one that stopped short (agents-registry.ts unfinishedOf), and that reading is only as
 * good as the agent's bookkeeping: a session that did its last step and never ticked it, or whose step the owner
 * redirected away from and never deleted, wears "1 of 5 steps unfinished" after landing, with nothing measured
 * wrong. The system prompt already asks for the list to be kept current, and a standing instruction decays as
 * context grows (agent-search.ts found the same for `rg`); a Stop is the one moment the list's state is about to be
 * read, so it is the one moment worth spending a sentence on.
 *
 * Read off the CLI's own task store (task-store.ts), keyed by the session the Stop names, not off the daemon's fold:
 * the store is what the next turn is seeded from and what the hand-off note prints, so it is the list that will be
 * believed. Asked once per turn: an agent stopping short on purpose says so and stops again, and a second ask would
 * be the loop this guard exists for. Advisory in wording too: closing an item the agent has not done would be worse
 * than leaving it open, so the note names the third way out. */

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
