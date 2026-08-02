// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

// The stream router's import chain reaches the app's environment read at module eval; jsdom plus this is the
// whole of what it wants (see useChat.test.ts, which cuts the same edge).
vi.hoisted(() => {
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

// The same edges useAgents.test.ts cuts, for the same reason: the fleet store sits behind the app shell, and
// this file's subject is one wire between the stream router and that store — nothing here wants a browser.
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
vi.mock("./sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { resetAgents, setAgents, useAgents } from "../agents/useAgents";
import { sandboxJson } from "./sandboxClient";
import { applySystemEvent } from "./systemEvents";

/* A DAEMON THAT RESTARTED IS A NEW REVISION LINE, and a browser tab outlives many of them.
 *
 * The fleet roster is versioned by a counter the daemon keeps in its own memory: it starts at 0 and is bumped
 * per published change, so a rebuild, an update or a crash hands the next connection numbers far below the
 * high-water mark this tab is holding. `setAgents` drops those as out-of-order — which is right within one
 * daemon and catastrophic across two: the board freezes at the instant before the restart, agents started
 * since never appear, and only a reload clears it.
 *
 * The stream's failure path reset the line, but that is one of four ways a stream ends and a REBUILD takes
 * another (the loopback listener dies with the container and the client demotes to the tunnel). So the reset
 * moved to the hello frame, which every connection begins with, whichever way the last one ended — and that is
 * what these hold it to. */
const SANDBOX = `sbx-1`;

const summary = (id: string, updatedAt: number): AgentSummary => ({
    id,
    status: `idle`,
    provider: `claude`,
    harness: `native`,
    updatedAt,
    attention: { plan: false, question: false, permission: false, conflict: false },
});

const hello = (): void => applySystemEvent({ kind: `hello`, workspaceId: `workspace`, build: `build-1` }, SANDBOX);
const roster = (agents: AgentSummary[], rev: number): void => applySystemEvent({ kind: `agents`, agents, rev }, SANDBOX);
// The roster's own cards. The board also carries the chat's client-only draft (an untouched "New agent" tab
// is a card before it is an agent), which is not what a revision line is about.
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
    let answer: (() => void) | undefined;
    vi.mocked(sandboxJson).mockImplementation(
        async () =>
            new Promise((resolve) => {
                answer = () => resolve({ agents: [summary(`a1`, 1_000)], rev: 900 });
            }),
    );

    const inFlight = useAgents().refresh(); // issued to the daemon that is about to go away
    hello(); // …which it does, and the connection that replaces it starts a new line
    answer?.();
    await inFlight;

    // The stale answer's revision 900 must not have become the mark the new daemon has to beat.
    roster([summary(`a1`, 2_000), summary(`a2`, 2_000)], 2);
    expect(ids()).toEqual([`a1`, `a2`]);
});
