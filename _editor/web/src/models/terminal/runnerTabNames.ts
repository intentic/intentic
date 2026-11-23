// The name of a runner terminal's tab (runnerTerminals.ts), apart from everything that dials one, so the turn's facts
// can name the tab without loading the roster. It carries all a dial needs: `runner~<runner>~<conversation>~<session>`,
// the session last since it is the one part that may hold a `~`.

export interface RunnerTerminal {
    readonly runner: string;
    readonly conversationId: string;
    readonly session: string;
}

const PREFIX = `runner~`;

/** A runner terminal's tab name. */
export const runnerTabName = (terminal: RunnerTerminal): string => `${PREFIX}${terminal.runner}~${terminal.conversationId}~${terminal.session}`;
export const isRunnerTab = (name: string): boolean => name.startsWith(PREFIX);

/** What a runner tab's name says, or undefined for any other name. */
export const parseRunnerTab = (name: string): RunnerTerminal | undefined => {
    if (!isRunnerTab(name)) {
        return undefined;
    }
    const rest = name.slice(PREFIX.length);
    const first = rest.indexOf(`~`);
    const second = first < 0 ? -1 : rest.indexOf(`~`, first + 1);
    if (first <= 0 || second <= first + 1 || second === rest.length - 1) {
        return undefined;
    }
    return { runner: rest.slice(0, first), conversationId: rest.slice(first + 1, second), session: rest.slice(second + 1) };
};

