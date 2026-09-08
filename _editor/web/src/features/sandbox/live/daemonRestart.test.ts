// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

// Needs jsdom: the stream router's import chain reaches the app's environment read at module eval.

// Mocks the router, analytics and sandbox client so only the wire between the stream router and the fleet store is
// exercised.
vi.mock("../../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
vi.mock("../client/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
vi.mock("../client/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { resetAgents, useAgents } from "../../agents/fleet/useAgents";
import { setAgents } from "../../agents/fleet/useAgents-registry";
import { sandboxJson } from "../client/sandboxClient";
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
    resetAgents();
    vi.mocked(sandboxJson).mockReset();
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
    vi.mocked(sandboxJson).mockImplementation(
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
