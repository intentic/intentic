import { shallowRef } from "vue";

// What the browser view needs to know about the agent whose turn opened a window: whether that turn is running now (an
// agent at work in the window, which the person watches and takes over), and what its conversation is called (the
// window's name in the window list). The board that knows both lives in features/agents, which already reaches this
// feature through capabilities, so importing it here would close a loop; the shell hands the answers in from above
// instead (shell/browserAgents.ts). Held in a ref, so a view drawn before they arrive redraws once they do.

export interface AgentTurns {
    readonly running: (conversation: string) => boolean;
    readonly title: (conversation: string) => string | undefined;
}

// Until the shell says otherwise, no turn is known to be running: a window the person can use rather than one they are
// locked out of by a board that hasn't loaded.
// allow(module-state): handed in once by the runtime above every route, as functions reading the board, which follows the current sandbox itself
const answers = shallowRef<AgentTurns>({ running: () => false, title: () => undefined });

export const provideAgentTurns = (turns: AgentTurns): void => {
    answers.value = turns;
};

export const agentTurnRunning = (conversation: string): boolean => answers.value.running(conversation);
export const agentTitle = (conversation: string): string | undefined => answers.value.title(conversation);
