import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { HeldChild } from "./child-held.js";

/* SUBAGENTS' WORK A TURN IS ABOUT TO LEAVE HELD, said back to it once at Stop. */

// A child whose land clashed with its parent's edits keeps its work on its branch, and once the parent stops supervising
// it, that held land calls the owner through the parent's card (sandbox-contract agent-lanes.ts callsOwner). On 2026-10-20
// an orchestrator ported two held children's work into its checkout by hand, kept a third back on purpose, and landed;
// its card then stood in Attention reading "3 need you", two of them over work already in main. The parent knew which
// was which and had no way to say so. Now it has (child-held.ts `settle`), and this is the moment it is reminded to.

// Enough of the list to act on; a long list is named by its count, not re-pasted.
const NAMED_CHILDREN = 8;

const childLine = (child: HeldChild): string => `- ${child.id}${child.title === undefined ? "" : ` ("${child.title}")`}`;

// The sentence: what is held, the three honest ends for each, and why it matters, in that order.
export const heldChildrenNote = (held: readonly HeldChild[]): string => {
    const named = held.slice(0, NAMED_CHILDREN).map(childLine);
    const rest = held.length - named.length;
    return [
        `${held.length === 1 ? "A subagent you started still holds work" : `${held.length} subagents you started still hold work`} on ${held.length === 1 ? "its branch" : "their branches"}, kept off your checkout by a land conflict:`,
        ...named,
        ...(rest > 0 ? [`- … +${rest} more`] : []),
        "Before you stop, settle each one: bring it in with merge if you still want it; if its work is already in your checkout because you applied or ported it yourself, " +
            "record that with settle; if you are keeping it back on purpose, leave it and say so plainly in your report. " +
            "A held land calls the owner once you stop supervising it, so one you already brought in would ask them about work that is done.",
    ].join("\n");
};

// What this module adds to the loop's hook set (agent.ts mergeHooks): one Stop matcher, or nothing.
export interface HeldChildrenHooks {
    readonly Stop?: HookCallbackMatcher[];
}

// A Stop matcher (run/agent.ts sessionHooks), beside the open checklist's (checklist-close.ts). `held` is the turn's own
// supervisor's reading (children.ts ChildSupervisor.held); a turn that may not supervise children wires nothing.
export const heldChildrenHooks = (held: (() => readonly HeldChild[]) | undefined): HeldChildrenHooks => {
    if (held === undefined) {
        return {};
    }
    // Once per turn: a second Stop is the model's answer to the first, and asking again would turn a reminder into a gate.
    let asked = false;
    return {
        Stop: [
            {
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "Stop" || asked) {
                            return {};
                        }
                        asked = true;
                        // The registry in memory, read now rather than when the turn began: a child settles mid-turn.
                        const children = held();
                        return children.length === 0 ? {} : { hookSpecificOutput: { hookEventName: "Stop", additionalContext: heldChildrenNote(children) } };
                    },
                ],
            },
        ],
    };
};
