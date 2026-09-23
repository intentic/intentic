import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { ref } from "vue";

// Needs jsdom: the stream router's import chain reaches the app's environment read at module eval.

// Mocks the router, analytics and sandbox client so only the wire between the stream router and the fleet store is
// exercised.
jest.mock("../../../router", () => ({ router: { push: jest.fn() } }));
jest.mock("../../../app/analytics", () => ({ track: jest.fn() }));
const activeSandboxId = ref<string | undefined>(undefined);
const reachable = ref(false);
jest.mock("../client/useSandbox", () => ({
    useSandbox: () => ({ activeSandboxId, reachable }),
    sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
}));
// Declared outside the factory with a path-only signature: the real `sandboxJson<T>` is generic, and an
// implementation returning one concrete shape cannot satisfy it.
const sandboxJsonMock = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
// Every name the app's graph imports from the daemon client, since bun links an ESM import against exactly what
// this factory returns; only the two below are ever called here.
jest.mock("../client/sandboxClient", () => ({
    sandboxJson: (...args: unknown[]) => sandboxJsonMock(...args),
    sandboxRequest: jest.fn(),
    sandboxBlob: jest.fn(),
    sandboxUpload: jest.fn(),
    sandboxError: jest.fn(async () => new Error(`unused`)),
}));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { useAgents } from "../../agents/fleet/useAgents";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import { queryClient } from "../../../lib/queryPersistence";
import { applySystemEvent } from "./systemEvents";

// A daemon restart resets the roster's revision counter; `setAgents` drops anything below this tab's mark, and the
// reset lives on the hello frame since a rebuild demotes the client without the stream's failure path.
const SANDBOX = `sbx-1`;

const summary = (id: string, updatedAt: number): AgentSummary => ({
    id,
    status: `idle`,
    provider: `claude`,
    harness: `native`,
    updatedAt,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
});

const hello = (): void => applySystemEvent({ kind: `hello`, workspaceId: `workspace`, build: `build-1` }, SANDBOX);
const roster = (agents: AgentSummary[], rev: number): void => applySystemEvent({ kind: `agents`, agents, rev }, SANDBOX);
// The roster's own cards, excluding the chat's client-only draft (a card before it's an agent).
const ids = (): string[] =>
    useAgents()
        .fleet.value.filter((agent) => agent.status !== `draft`)
        .map((agent) => agent.id);

beforeEach(() => {
    resetSandboxScope();
    sandboxJsonMock.mockReset();
});

it(`takes the roster of a daemon that started counting again`, () => {
    // A tab that has been open a while: hundreds of published changes deep into one daemon's line.
    setAgents([summary(`a1`, 1_000)], 800);

    hello(); // the reconnect — to a daemon that has just been rebuilt, numbering from scratch
    roster([summary(`a1`, 2_000), summary(`a2`, 2_000)], 1);

    expect(ids()).toEqual([`a1`, `a2`]);
});

it(`ignores a roster read answering for the daemon it has already left`, async () => {
    setAgents([summary(`a1`, 1_000)], 800);
    // Two reads answer for two daemons: the stale one under test, and the hello's own pull on the new line.
    const answers: (() => void)[] = [];
    sandboxJsonMock.mockImplementation(
        async () =>
            new Promise((resolve) => {
                const rev = answers.length === 0 ? 900 : 1;
                answers.push(() => resolve({ agents: [summary(`a1`, 1_000)], rev }));
            }),
    );

    const inFlight = useAgents().refresh(); // issued to the daemon that is about to go away
    hello(); // …which it does, and the connection that replaces it starts a new line
    for (const answer of answers) {
        answer();
    }
    await inFlight;
    await Promise.resolve();

    // The stale answer's revision 900 must not have become the mark the new daemon has to beat.
    roster([summary(`a1`, 2_000), summary(`a2`, 2_000)], 2);
    expect(ids()).toEqual([`a1`, `a2`]);
});

// Cached reads are taken as true between frames (staleTime, queryPersistence), which puts the whole weight of freshness
// on the stream. A reconnect is the seam where that cache stops being evidence: frames sent while this browser was away
// are gone, and one hydrated from disk can be hours old.
it(`distrusts everything the cache holds when the stream reconnects`, () => {
    const key = [`held-across-a-reconnect`];
    queryClient.setQueryData<{ from: string }>(key, { from: `before the gap` });
    expect(queryClient.getQueryState(key)?.isInvalidated, `nothing has happened to it yet`).toBe(false);

    hello();

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    // Still held, so an active screen repaints from it while the refetch runs rather than blanking.
    expect(queryClient.getQueryData<{ from: string }>(key)).toEqual({ from: `before the gap` });
});
