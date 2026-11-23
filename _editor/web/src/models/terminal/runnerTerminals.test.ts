// A runner conversation's terminal as a tab: a name that carries the runner, the conversation and the session (which may
// hold a `~`), held per sandbox so a reload reattaches it, a fresh `runners.openView` ticket for every dial with the
// attach's grid and sight added to its query, and the Done banner's ask read off the conversation's pending card.
import "@intentic/testing/dom";
import type { RunnerOpenViewInput } from "@intentic/sandbox-contract/schemas/runner-views";
import type { TranscriptTerminalHelp } from "@intentic/sandbox-contract/events/transcript";
import type { TerminalParams } from "./terminalDoor";
import { isRunnerTab, parseRunnerTab, runnerTabName } from "./runnerTabNames";
import {
    forgetRunnerTerminal,
    holdRunnerTerminal,
    pendingTerminalHelp,
    runnerDoor,
    runnerTerminalHelp,
    runnerTerminalTabs,
    terminalTabFor,
} from "./runnerTerminals";

const BASE = `https://sbx.example.test`;
const PARAMS: TerminalParams = { session: `ignored`, cols: `120`, rows: `32`, deflate: `1` };
const terminal = { runner: `rog`, conversationId: `conv-1`, session: `agent-a~b` };
const NAME = `runner~rog~conv-1~agent-a~b`;

afterEach(() => forgetRunnerTerminal(NAME));

describe(`a runner tab's name`, () => {
    it(`carries the runner, the conversation and the session, the session last`, () => {
        expect(runnerTabName(terminal)).toBe(NAME);
        expect(parseRunnerTab(NAME)).toEqual(terminal);
        expect([isRunnerTab(NAME), isRunnerTab(`web-3a2b`), isRunnerTab(`device~rog~t-1`)]).toEqual([true, false, false]);
    });

    it(`reads nothing out of a name that is not one`, () => {
        expect([parseRunnerTab(`web-3a2b`), parseRunnerTab(`runner~rog`), parseRunnerTab(`runner~rog~conv-1~`), parseRunnerTab(`runner~~c~s`)]).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
        ]);
    });
});

describe(`the tab a conversation's session opens as`, () => {
    const runnerOf = (id: string | undefined): string | undefined => (id === `conv-1` ? `rog` : undefined);

    it(`is the runner's tab for a conversation that runs on one`, () => {
        expect(terminalTabFor(`conv-1`, `agent-a~b`, runnerOf)).toBe(NAME);
    });

    it(`is the session itself for one that runs here, or none known`, () => {
        expect(terminalTabFor(`conv-2`, `agent-x`, runnerOf)).toBe(`agent-x`);
        expect(terminalTabFor(undefined, `agent-x`, runnerOf)).toBe(`agent-x`);
    });

    it(`leaves a name that already is a runner tab as it stands`, () => {
        expect(terminalTabFor(`conv-1`, NAME, runnerOf)).toBe(NAME);
    });
});

describe(`the held runner tabs`, () => {
    it(`holds a runner tab once, lists it as a runner tab, and lets it go`, () => {
        holdRunnerTerminal(NAME);
        holdRunnerTerminal(NAME);
        holdRunnerTerminal(`web-3a2b`);
        expect(runnerTerminalTabs()).toEqual([{ name: NAME, label: `rog · agent-a~b`, kind: `runner`, running: true, activityAt: 0 }]);
        forgetRunnerTerminal(NAME);
        expect(runnerTerminalTabs()).toEqual([]);
    });
});

describe(`a runner terminal's door`, () => {
    it(`asks for a fresh view on every dial, and adds the attach's grid and sight to its ticket`, async () => {
        const asked: RunnerOpenViewInput[] = [];
        let issued = 0;
        const door = runnerDoor(terminal, {
            base: () => BASE,
            openView: async (input) => {
                asked.push(input);
                issued += 1;
                return { runner: `rog`, path: `/system/runner-view/rog/system/terminal`, query: `ticket=t${issued}&session=agent-a%7Eb` };
            },
        });
        await expect(door.address(PARAMS)).resolves.toEqual({
            base: BASE,
            path: `/system/runner-view/rog/system/terminal`,
            query: `ticket=t1&session=agent-a%7Eb&cols=120&rows=32&deflate=1`,
        });
        await expect(door.address({ ...PARAMS, away: `1` })).resolves.toMatchObject({ query: `ticket=t2&session=agent-a%7Eb&cols=120&rows=32&away=1&deflate=1` });
        expect(asked).toEqual([
            { conversationId: `conv-1`, kind: `terminal`, session: `agent-a~b` },
            { conversationId: `conv-1`, kind: `terminal`, session: `agent-a~b` },
        ]);
    });

    it(`dials nowhere, and asks for no ticket, while this sandbox is unreachable`, async () => {
        const openView = jest.fn(async () => ({ runner: `rog`, path: `/p`, query: `` }));
        await expect(runnerDoor(terminal, { base: () => undefined, openView }).address(PARAMS)).resolves.toBeUndefined();
        expect(openView).not.toHaveBeenCalled();
    });
});

describe(`a runner tab's ask`, () => {
    const ask = (requestId: string, session: string, status: TranscriptTerminalHelp[`status`]) => ({
        terminalHelp: { requestId, session, message: `Type the code for ${requestId}`, status } satisfies TranscriptTerminalHelp,
    });
    const rows = [ask(`r1`, `agent-a~b`, `helped`), {}, ask(`r2`, `agent-a~b`, `pending`), ask(`r3`, `other`, `pending`)];

    it(`is the newest hand-over still waiting at its session`, () => {
        expect(pendingTerminalHelp(rows, `agent-a~b`)).toEqual({ requestId: `r2`, message: `Type the code for r2` });
        expect(pendingTerminalHelp(rows.slice(0, 2), `agent-a~b`)).toBeUndefined();
    });

    it(`is read off the tab's own conversation, and only for a runner tab`, () => {
        const rowsOf = (id: string) => (id === `conv-1` ? rows : undefined);
        expect(runnerTerminalHelp(NAME, rowsOf)).toEqual({ requestId: `r2`, message: `Type the code for r2` });
        expect(runnerTerminalHelp(`runner~rog~conv-2~agent-a~b`, rowsOf)).toBeUndefined();
        expect(runnerTerminalHelp(`agent-a~b`, rowsOf)).toBeUndefined();
        expect(runnerTerminalHelp(undefined, rowsOf)).toBeUndefined();
    });
});
