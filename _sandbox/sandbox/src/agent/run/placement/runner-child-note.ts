import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../../composition.js";
import type { ConversationWorktree } from "../../../conversations/worktrees/worktrees.js";
import { dispatchRemoteTurn } from "../../../runners/runner-dispatch.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { workspaceMemoryFiles } from "../../prompt/workspace-memory.js";
import { childNoteFor } from "../../subagents/starting/child-preamble.js";

// A turn that runs on a runner, sent with the note a spawned child opens with (child-preamble.ts). The note is written
// here, where the child's record, its siblings and its parent are: the runner holds none of them, so the two children
// placed on a runner in the shinobi-society audit (2026-11-21) started without being told not to commit, where their
// artifacts go or how to report. Its instruction files are read off this sandbox's mirror of the checkout the runner
// works in, which holds the same files.

const runnerChildNote = async (services: Services, input: RoutedTurn, conversationId: string, worktree: ConversationWorktree): Promise<TurnNote | undefined> =>
    childNoteFor(
        { conversations: services.conversations, agents: services.agents, inFlight: services.inFlight, memoryFiles: workspaceMemoryFiles },
        {
            conversationId,
            prompt: input.prompt,
            sessionId: input.sessionId,
            root: worktree.cwd,
            start: worktree.cwd,
            runtime: capabilitiesOf(input.agent, input.harness).runtime,
            outputCleaners: (await services.sandboxSettings.get()).outputCleaners,
        },
    );

/** `dispatchRemoteTurn`, carrying a spawned child's opening note when this turn is one that opens with its brief. */
export const dispatchToRunner = (
    services: Services,
    input: RoutedTurn & { conversationId: string },
    runner: string,
    worktree: ConversationWorktree,
    signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent> => dispatchRemoteTurn(services, input, runner, worktree, signal, () => runnerChildNote(services, input, input.conversationId, worktree));
