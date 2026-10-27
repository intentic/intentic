import type { SandboxHandlerInput, SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { listeners } from "../board/roster";

// The terminal sessions the sandbox holds (system.terminals), the close a tab's x sends, and the history a pane has
// scrolled past. The demo's own session is the checkout agent's, where its tests ran; other stores add the sessions
// their own work starts (an apply, a dev server) through `registerTerminalSource`, and are asked first to end their own.

type TerminalSession = SandboxHandlerOutput<`system`, `terminals`>[`sessions`][number];

interface TerminalSource {
    readonly list: () => TerminalSession[];
    readonly kill?: (name: string) => boolean;
}

const sources: TerminalSource[] = [];
export const registerTerminalSource = (list: TerminalSource[`list`], kill?: TerminalSource[`kill`]): void => {
    sources.push(kill === undefined ? { list } : { list, kill });
};

const AGENT_SESSION = `agent-checkout-stripe`;
const closed = new Set<string>();

export const terminalsList = (): SandboxHandlerOutput<`system`, `terminals`> => ({
    sessions: [
        ...(closed.has(AGENT_SESSION) ? [] : [{ name: AGENT_SESSION, label: `checkout-stripe`, kind: `agent` as const, running: true, activityAt: Date.now() }]),
        ...sources.flatMap((source) => source.list()),
    ],
});

const pushTerminals = (): void => {
    for (const listener of listeners) {
        listener({ kind: `runtimeChanged`, domains: [`terminals`] });
    }
};

// Destroys the session and whatever ran in it; a name nothing holds is the daemon's 404.
export const killTerminal = ({ name }: SandboxHandlerInput<`system`, `killTerminal`>): SandboxHandlerOutput<`system`, `killTerminal`> => {
    const ended = sources.some((source) => source.kill?.(name) === true);
    if (!ended) {
        if (name !== AGENT_SESSION || closed.has(name)) {
            return refuse(`No terminal session is called ${name}.`, 404);
        }
        closed.add(name);
    }
    pushTerminals();
    return { ok: true };
};

// What the checkout agent's pane has scrolled past: its test run, as plain text a reader can select and copy.
const AGENT_HISTORY = [
    `ada@acme-shop:/work$ pnpm -C web install --frozen-lockfile`,
    `Lockfile is up to date, resolution step is skipped`,
    `Packages: +3`,
    `+++`,
    `Done in 1.8s`,
    `ada@acme-shop:/work$ pnpm -C web test checkout`,
    ``,
    `> acme-web@0.1.0 test`,
    `> vitest run checkout`,
    ``,
    ` RUN  v3.2.4 /work/web`,
    ``,
    ` ✓ tests/checkout.spec.ts (3 tests) 214ms`,
    `   ✓ redirects to the Stripe session url`,
    `   ✓ shows the pending state while the session is created`,
    `   ✓ surfaces a failed session without navigating`,
    ``,
    ` Test Files  1 passed (1)`,
    `      Tests  3 passed (3)`,
    `   Duration  2.14s`,
    ``,
    `ada@acme-shop:/work$ `,
];

export const terminalScrollback = ({ name, lines }: SandboxHandlerInput<`system`, `terminalScrollback`>): SandboxHandlerOutput<`system`, `terminalScrollback`> => {
    if (!terminalsList().sessions.some((session) => session.name === name)) {
        return refuse(`No terminal session is called ${name}.`, 404);
    }
    const history = name === AGENT_SESSION ? AGENT_HISTORY : [`$ `];
    const kept = history.slice(-lines);
    return { name, text: kept.join(`\n`), lines: kept.length, truncated: kept.length < history.length };
};
