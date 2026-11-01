import type { TranscriptBackgroundJob } from "@intentic/sandbox-contract/events/transcript";
import type { ChatMessage, ChatTurn } from "../../../../models/conversations/transcript/transcript";

export interface JobGroups {
    readonly heads: ReadonlyMap<number, readonly TranscriptBackgroundJob[]>;
    readonly folded: ReadonlySet<number>;
}

// Group by transcript adjacency, never by completion time. Live state changes the disclosure, not its identity, so
// inspecting a command survives the last job finishing. Each turn and each edit/fork boundary starts a new group.
export const jobGroupsOf = (turns: readonly ChatTurn[], cuts: ReadonlyMap<number, number>, doomed: ReadonlySet<number>): JobGroups => {
    const heads = new Map<number, readonly TranscriptBackgroundJob[]>();
    const folded = new Set<number>();
    for (const turn of turns) {
        let run: ChatMessage[] = [];
        const flush = (): void => {
            if (run.length > 1) {
                heads.set(run[0]!.id, run.map((message) => message.backgroundJob!));
                for (const message of run.slice(1)) {
                    folded.add(message.id);
                }
            }
            run = [];
        };
        for (const message of turn.messages) {
            if (cuts.has(message.id) || (run.length > 0 && doomed.has(message.id) !== doomed.has(run[0]!.id))) {
                flush();
            }
            if (message.role !== `notice` || message.backgroundJob === undefined || message.notes?.length) {
                flush();
            } else {
                run.push(message);
            }
        }
        flush();
    }
    return { heads, folded };
};
