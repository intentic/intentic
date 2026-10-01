// The board's early paint: the roster the stream last sent, stored per sandbox and read back at the next start, so a
// phone's first screen draws cards before the connection answers. Never across a build, never a broken record.
import "@intentic/testing/dom";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { readStoredRoster } from "../useAgents-registry";

const agent: AgentSummary = {
    id: `a1`,
    status: `running`,
    title: `Fix the build`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
};

afterEach(() => {
    localStorage.clear();
});

it(`reads back the roster this build stored for the sandbox`, () => {
    localStorage.setItem(`intentic.roster.sb1`, JSON.stringify({ build: `b1`, agents: [agent] }));

    expect(readStoredRoster(`sb1`, `b1`)).toEqual([agent]);
    expect(readStoredRoster(`sb2`, `b1`)).toEqual([]);
});

it(`reads nothing from another build, a broken record, or no sandbox at all`, () => {
    localStorage.setItem(`intentic.roster.sb1`, JSON.stringify({ build: `b0`, agents: [agent] }));
    expect(readStoredRoster(`sb1`, `b1`)).toEqual([]);

    localStorage.setItem(`intentic.roster.sb1`, `{not json`);
    expect(readStoredRoster(`sb1`, `b1`)).toEqual([]);

    localStorage.setItem(`intentic.roster.sb1`, JSON.stringify({ build: `b1`, agents: `many` }));
    expect(readStoredRoster(`sb1`, `b1`)).toEqual([]);
    expect(readStoredRoster(undefined, `b1`)).toEqual([]);
});
