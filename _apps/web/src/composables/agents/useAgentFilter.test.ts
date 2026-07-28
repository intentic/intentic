import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same module-eval cuts useAgents.test.ts makes: importing the fleet store pulls useChat -> the app shell, and
// the router / analytics / sandbox modules all read environment.ts's `window.env` at import time. Nothing here
// touches them.
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(`sbx-1`), reachable: ref(true) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
// Answering NOT FOUND rather than `undefined`: these cases run on fake timers, so useChat's hydrate watch —
// which the sibling suites never advance far enough to reach — actually runs here, and a bare vi.fn() sends it
// into `response.ok` on nothing. What it hydrates is irrelevant to the filter; that it fails quietly is not.
vi.mock("../sandbox/sandboxClient", () => ({
    sandboxJson: vi.fn(async () => ({})),
    sandboxRequest: vi.fn(async () => ({ ok: false, status: 404, body: null })),
}));

/* The daemon tier, stubbed at the useQuery seam.
 *
 * What is under test is the MERGE — which tier answers for which agent, and what evidence each produces — not
 * TanStack's fetching. Driving it through a real query would mean a client, a provider and fake timers for the
 * debounce, all to observe the same two refs this hands over directly. `fleetAnswer` / `sessionAnswer` are set
 * per test and routed by the query key's first segment.
 */
const answers = { agents: undefined as unknown, sessions: undefined as unknown };
vi.mock("@tanstack/vue-query", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/vue-query")>();
    const { computed, ref, unref } = await import("vue");
    return {
        ...actual,
        useQuery: (options: { queryKey: Ref<unknown[]> }) => ({
            data: computed(() => (unref(options.queryKey)[0] === `agents` ? answers.agents : answers.sessions)),
            isFetching: ref(false),
        }),
    };
});

import type { AgentSummary } from "@intentic/sandbox-contract";
import { effectScope, nextTick, type EffectScope, type Ref } from "vue";
import { Conversation } from "../chat/conversation";
import { useChat } from "../chat/useChat";
import { markSegments, useAgentFilter } from "./useAgentFilter";
import { type FleetAgent, resetAgents, setAgents, useAgents } from "./useAgents";

const none = { plan: false, question: false, permission: false, conflict: false };
const agent = (id: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
    id,
    status: `idle`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1,
    attention: none,
    ...extra,
});

// The composable debounces its daemon tier by 150ms; the local tier answers on the tick. `settle` waits out
// the timer so the stubbed answer is considered current (the composable ignores a reply for an older query).
const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
};

/* The tab list is never EMPTIED — useChat guarantees an active conversation at all times and its computeds
 * read straight through that guarantee (`active` falls back to list[0]). Each case gets one non-isolated
 * placeholder to stand in for it: isolated is the default, and an isolated conversation with no registry entry
 * IS a draft card in the fleet, which would skew every count here.
 *
 * `activeId` is deliberately left alone: `active` resolving to the placeholder by its list[0] floor is all
 * these tests need, and pointing it at a tab only buys a hydrate none of them asked for.
 */
const placeholder = (): Conversation => {
    const blank = new Conversation(`blank`);
    blank.isolated.value = false;
    return blank;
};

/* The composable inside an effect scope, the way a component's setup runs it. Not ceremony: it registers a
 * debounce watcher and an onScopeDispose, so a bare call would both warn and leak one watcher per case onto
 * computeds derived from module singletons every other suite in this file shares. */
let scope: EffectScope | undefined;
const filterIn = (): ReturnType<typeof useAgentFilter> => {
    scope = effectScope();
    return scope.run(() => useAgentFilter()) as ReturnType<typeof useAgentFilter>;
};

afterEach(() => {
    scope?.stop();
    scope = undefined;
});

beforeEach(() => {
    vi.useFakeTimers();
    resetAgents();
    answers.agents = undefined;
    answers.sessions = undefined;
    useChat().conversations.value = [placeholder()];
    useAgents().archived.value = [];
});

describe(`useAgentFilter`, () => {
    it(`leaves the board alone below the two-character floor`, async () => {
        setAgents([agent(`a1`, { title: `fix the login bug` })], 1);
        const filter = filterIn();
        filter.query.value = `f`;
        await settle();
        expect(filter.active.value).toBe(false);
        // Everything matches while inactive, so a single typed character can't empty the lanes.
        expect(filter.matches(useAgents().fleet.value[0] as FleetAgent)).toBe(true);
    });

    it(`matches the title locally and reports no snippet for it`, async () => {
        setAgents([agent(`a1`, { title: `fix the login bug` }), agent(`a2`, { title: `tidy the readme` })], 1);
        const filter = filterIn();
        filter.query.value = `login`;
        await nextTick();
        const [first, second] = useAgents().fleet.value as FleetAgent[];
        expect(filter.matches(first as FleetAgent)).toBe(true);
        expect(filter.matches(second as FleetAgent)).toBe(false);
        // The card already shows the title it matched on; a line repeating it is noise, not evidence.
        expect(filter.snippetOf(first as FleetAgent)).toBeUndefined();
    });

    // The point of the local tier: a tab this browser holds needs no round trip, and answers on the keystroke.
    it(`matches a later prompt of an OPEN tab without the daemon, and quotes the line`, async () => {
        setAgents([agent(`a1`, { title: `fix the login bug` })], 1);
        const conversation = new Conversation(`a1`);
        conversation.restoreMessages([
            { role: `user`, text: `fix the login bug` },
            { role: `assistant`, text: `landAgent is defined in laneDrop.ts` },
            { role: `user`, text: `actually make it use landAgent instead` },
        ]);
        useChat().conversations.value = [placeholder(), conversation];

        const filter = filterIn();
        filter.query.value = `landagent`;
        await nextTick();
        const target = useAgents().fleet.value[0] as FleetAgent;
        expect(filter.matches(target)).toBe(true);
        expect(filter.snippetOf(target)).toBe(`actually make it use landAgent instead`);
    });

    // …and the point of the rule: the agent's OWN words are not a match, or a fleet-wide query returns the fleet.
    it(`ignores the assistant's replies in an open tab`, async () => {
        setAgents([agent(`a1`, { title: `fix the login bug` })], 1);
        const conversation = new Conversation(`a1`);
        conversation.restoreMessages([
            { role: `user`, text: `fix the login bug` },
            { role: `assistant`, text: `landAgent is defined in laneDrop.ts` },
        ]);
        useChat().conversations.value = [placeholder(), conversation];

        const filter = filterIn();
        filter.query.value = `landagent`;
        await nextTick();
        expect(filter.matches(useAgents().fleet.value[0] as FleetAgent)).toBe(false);
    });

    it(`falls through to the daemon for an agent this browser never opened`, async () => {
        setAgents([agent(`a1`, { title: `fix the login bug` })], 1);
        answers.agents = { matches: [{ id: `a1`, snippet: `…use landAgent instead` }], scanned: 1 };
        const filter = filterIn();
        filter.query.value = `landagent`;
        await settle();
        const target = useAgents().fleet.value[0] as FleetAgent;
        expect(filter.matches(target)).toBe(true);
        expect(filter.snippetOf(target)).toBe(`…use landAgent instead`);
    });

    // The tiers are a union over one agent, so a card can never be listed twice or wear two snippets — the
    // local answer, which is the one this browser can prove, wins.
    it(`prefers the local answer when both tiers hit the same agent`, async () => {
        setAgents([agent(`a1`, { title: `whatever` })], 1);
        const conversation = new Conversation(`a1`);
        conversation.restoreMessages([{ role: `user`, text: `the landAgent bug` }]);
        useChat().conversations.value = [placeholder(), conversation];
        answers.agents = { matches: [{ id: `a1`, snippet: `stale daemon line` }], scanned: 1 };

        const filter = filterIn();
        filter.query.value = `landagent`;
        await settle();
        expect(filter.snippetOf(useAgents().fleet.value[0] as FleetAgent)).toBe(`the landAgent bug`);
    });

    it(`surfaces archived matches, which are off the roster entirely`, async () => {
        setAgents([agent(`a1`, { title: `tidy the readme` })], 1);
        useAgents().archived.value = [{ ...agent(`old`, { title: `the landAgent rewrite`, archivedAt: 2 }), open: false, unread: false }];
        const filter = filterIn();
        filter.query.value = `landagent`;
        await settle();
        expect(filter.archivedMatches.value.map((match) => match.id)).toEqual([`old`]);
    });

    // A conversation a fleet agent owns must not be reported twice — once as its card and once as an
    // anonymous history row that opens the very same tab.
    it(`drops session matches that a fleet agent already carries`, async () => {
        setAgents([agent(`a1`, { title: `tidy the readme`, sessionId: `sess-1` })], 1);
        answers.sessions = {
            sessions: [
                { id: `sess-1`, title: `tidy the readme`, updatedAt: 1 },
                { id: `sess-9`, title: `an old plain chat`, updatedAt: 1, snippet: `about landAgent` },
            ],
        };
        const filter = filterIn();
        filter.query.value = `landagent`;
        await settle();
        expect(filter.sessionMatches.value.map((session) => session.id)).toEqual([`sess-9`]);
    });
});

// The term is marked without v-html — this text is a user's own prompt, which is not trusted markup.
describe(`markSegments`, () => {
    it(`marks every occurrence, not just the first`, () => {
        expect(markSegments(`land and land again`, `land`)).toEqual([
            { text: `land`, hit: true },
            { text: ` and `, hit: false },
            { text: `land`, hit: true },
            { text: ` again`, hit: false },
        ]);
    });

    it(`matches case-insensitively while keeping the original casing`, () => {
        expect(markSegments(`the LandAgent bug`, `landagent`)).toEqual([
            { text: `the `, hit: false },
            { text: `LandAgent`, hit: true },
            { text: ` bug`, hit: false },
        ]);
    });

    it(`returns one plain run when there is nothing to mark`, () => {
        expect(markSegments(`nothing here`, `zzz`)).toEqual([{ text: `nothing here`, hit: false }]);
        expect(markSegments(`nothing here`, ``)).toEqual([{ text: `nothing here`, hit: false }]);
    });
});
