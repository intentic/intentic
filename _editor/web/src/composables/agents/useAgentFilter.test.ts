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
// These cases run on fake timers, so useChat's hydrate watch, which the sibling suites never advance far
// enough to reach: actually runs here. The registered placeholder has an empty transcript; other requests
// answer NOT FOUND. What it hydrates is irrelevant to the filter, but a named transcript 404 would correctly
// unlatch `registered` and turn the placeholder into the workspace draft this suite is trying to exclude.
vi.mock("../sandbox/sandboxClient", () => ({
    sandboxJson: vi.fn(async () => ({})),
    sandboxRequest: vi.fn(async (path: string) =>
        path === `/agents/blank/transcript`
            ? { ok: true, status: 200, body: null, json: async () => ({ messages: [] }) }
            : { ok: false, status: 404, body: null },
    ),
}));

/* The daemon tier, stubbed at the useQuery seam.
 *
 * What is under test is the MERGE, which tier answers for which agent, and what evidence each produces, not
 * TanStack's fetching. Driving it through a real query would mean a client, a provider and fake timers for the
 * debounce, all to observe the same two refs this hands over directly. `fleetAnswer` / `sessionAnswer` are set
 * per test and routed by the query key's first segment.
 */
const answers = { agents: undefined as unknown, sessions: undefined as unknown };
// The keys the composable asked under, kept live: what the daemon is being asked is half of what the filter
// does, and the match switches ride in the key exactly so a flip re-asks (see useAgentFilter's `params`).
const keys: Ref<unknown[]>[] = [];
vi.mock("@tanstack/vue-query", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/vue-query")>();
    const { computed, ref, unref } = await import("vue");
    return {
        ...actual,
        useQuery: (options: { queryKey: Ref<unknown[]> }) => {
            keys.push(options.queryKey);
            return {
                data: computed(() => (unref(options.queryKey)[0] === `agents` ? answers.agents : answers.sessions)),
                isFetching: ref(false),
            };
        },
    };
});

import type { AgentSummary } from "@intentic/sandbox-contract";
import { effectScope, nextTick, unref, type EffectScope, type Ref } from "vue";
import { Conversation } from "../chat/conversation";
import { useChat } from "../chat/useChat";
import { useAgentFilter } from "./useAgentFilter";
import { type FleetAgent, resetAgents, setAgents, useAgents } from "./useAgents";

const none = { plan: false, question: false, permission: false, service: false, capability: false, conflict: false };
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

/* The tab list is never EMPTIED: useChat guarantees an active conversation at all times and its computeds
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
    blank.registered.value = true;
    return blank;
};

/* The composable inside an effect scope, the way a component's setup runs it. Not ceremony: it registers a
 * debounce watcher and an onScopeDispose, so a bare call would both warn and leak one watcher per case onto
 * computeds derived from module singletons every other suite in this file shares. */
let scope: EffectScope | undefined;
let current: ReturnType<typeof useAgentFilter> | undefined;
const filterIn = (): ReturnType<typeof useAgentFilter> => {
    scope = effectScope();
    current = scope.run(() => useAgentFilter()) as ReturnType<typeof useAgentFilter>;
    return current;
};

afterEach(() => {
    // `matchCase` is ONE preference behind every field (and written through to storage), so a case that turns
    // it on hands it back: the next case would otherwise silently run under a rule it never asked for.
    if (current !== undefined) {
        current.matchCase.value = false;
    }
    current = undefined;
    scope?.stop();
    scope = undefined;
});

beforeEach(() => {
    vi.useFakeTimers();
    resetAgents();
    keys.length = 0;
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
        // Both sides said "landAgent" here, and the line shown is the user's own: their phrasing is what a
        // query is typed from.
        expect(filter.snippetOf(target)).toEqual({ text: `actually make it use landAgent instead`, speaker: `user` });
    });

    // The agent's half of an open tab matches too, and reports itself as the agent's: a reply quoted under a
    // card reads as something the user wrote unless the row says whose words they were.
    it(`matches the agent's own reply in an open tab and names the speaker`, async () => {
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
        const target = useAgents().fleet.value[0] as FleetAgent;
        expect(filter.matches(target)).toBe(true);
        expect(filter.snippetOf(target)).toEqual({ text: `landAgent is defined in laneDrop.ts`, speaker: `agent` });
    });

    // A notice is neither side speaking: it is something that happened to the turn, so it is not searchable.
    it(`never matches a notice line`, async () => {
        setAgents([agent(`a1`, { title: `fix the login bug` })], 1);
        const conversation = new Conversation(`a1`);
        conversation.restoreMessages([
            { role: `user`, text: `fix the login bug` },
            { role: `notice`, text: `landAgent branch was rebased` },
        ]);
        useChat().conversations.value = [placeholder(), conversation];

        const filter = filterIn();
        filter.query.value = `landagent`;
        await nextTick();
        expect(filter.matches(useAgents().fleet.value[0] as FleetAgent)).toBe(false);
    });

    it(`falls through to the daemon for an agent this browser never opened`, async () => {
        setAgents([agent(`a1`, { title: `fix the login bug` })], 1);
        answers.agents = { matches: [{ id: `a1`, snippet: { text: `…use landAgent instead`, speaker: `user` } }], scanned: 1 };
        const filter = filterIn();
        filter.query.value = `landagent`;
        await settle();
        const target = useAgents().fleet.value[0] as FleetAgent;
        expect(filter.matches(target)).toBe(true);
        expect(filter.snippetOf(target)).toEqual({ text: `…use landAgent instead`, speaker: `user` });
    });

    // The tiers are a union over one agent, so a card can never be listed twice or wear two snippets: the
    // local answer, which is the one this browser can prove, wins.
    it(`prefers the local answer when both tiers hit the same agent`, async () => {
        setAgents([agent(`a1`, { title: `whatever` })], 1);
        const conversation = new Conversation(`a1`);
        conversation.restoreMessages([{ role: `user`, text: `the landAgent bug` }]);
        useChat().conversations.value = [placeholder(), conversation];
        answers.agents = { matches: [{ id: `a1`, snippet: { text: `stale daemon line`, speaker: `user` } }], scanned: 1 };

        const filter = filterIn();
        filter.query.value = `landagent`;
        await settle();
        expect(filter.snippetOf(useAgents().fleet.value[0] as FleetAgent)).toEqual({ text: `the landAgent bug`, speaker: `user` });
    });

    /* THE Aa SWITCH, on the tier that answers first. Off, the letters do not matter and both cards stay; on,
     * the query stands as typed, which is the whole reason someone reaches for it, to tell FROM from from. */
    it(`keeps both casings by default and separates them under match case`, async () => {
        setAgents([agent(`a1`, { title: `FROM the top` }), agent(`a2`, { title: `from the top` })], 1);
        const filter = filterIn();
        filter.query.value = `FROM`;
        await nextTick();
        const [upper, lower] = useAgents().fleet.value as FleetAgent[];
        expect(filter.matches(upper as FleetAgent)).toBe(true);
        expect(filter.matches(lower as FleetAgent)).toBe(true);

        filter.matchCase.value = true;
        await nextTick();
        expect(filter.matches(upper as FleetAgent)).toBe(true);
        expect(filter.matches(lower as FleetAgent)).toBe(false);
    });

    // …and the daemon tier is asked under the same rule, or the half of the fleet this browser never opened
    // would come back matched by the other one.
    it(`carries the case rule to the daemon, and re-asks the moment it is flipped`, async () => {
        setAgents([agent(`a1`, { title: `tidy the readme` })], 1);
        const filter = filterIn();
        filter.query.value = `FROM`;
        await settle();
        expect(keys.every((key) => !String(unref(key)).includes(`caseSensitive`))).toBe(true);

        // Flipping the switch re-folds the term as well as changing the rule, so the ask settles with the
        // query as TYPED. Until it does, the composable's own guard (`settled !== needle`) holds the daemon's
        // older answer back rather than showing hits found under the other rule.
        filter.matchCase.value = true;
        await settle();
        // Both tiers' keys: the fleet's and the never-carded sessions', or the board would list rows found
        // under a rule its cards were not.
        expect(keys.map((key) => String(unref(key))).filter((key) => key.includes(`query=FROM&caseSensitive=true`))).toHaveLength(2);
    });

    /* THE BOARD MEMOISES A CARD ON THIS SNIPPET (AgentsView hands it to `v-memo`), so an equal-but-new object
     * every time it is asked IS a reported change: every matched card would redraw on every roster frame, which
     * is the exact cost that memo was added to remove. The evidence therefore keeps its identity for as long as
     * it says the same thing. */
    it(`reports one unchanged hit as the same object every time it is asked`, async () => {
        setAgents([agent(`a1`, { title: `whatever` })], 1);
        const conversation = new Conversation(`a1`);
        conversation.restoreMessages([{ role: `user`, text: `the landAgent bug` }]);
        useChat().conversations.value = [placeholder(), conversation];

        const filter = filterIn();
        filter.query.value = `landagent`;
        await nextTick();
        const target = useAgents().fleet.value[0] as FleetAgent;
        const first = filter.snippetOf(target);
        expect(first).toEqual({ text: `the landAgent bug`, speaker: `user` });

        // The board asks about seven times per render (cardsFor runs five times over, then the card reads its
        // own match twice), and every one of them has to be the same answer rather than a new one.
        expect(filter.snippetOf(target)).toBe(first);

        // ...and across a rebuild of the local index, which every frame of every streaming turn causes: the
        // line this hit quotes is untouched, so the hit is still the same hit.
        conversation.restoreMessages([
            { role: `user`, text: `the landAgent bug` },
            { role: `assistant`, text: `looking at it now` },
        ]);
        await nextTick();
        expect(filter.snippetOf(target)).toBe(first);
    });

    // ...but a rename is a real change of input, and the memo must not answer for the name it cached under.
    it(`stops matching a title the user has renamed away from the query`, async () => {
        setAgents([agent(`a1`, { title: `the landAgent rewrite` })], 1);
        const filter = filterIn();
        filter.query.value = `landagent`;
        await nextTick();
        const target = useAgents().fleet.value[0] as FleetAgent;
        expect(filter.matches(target)).toBe(true);

        setAgents([agent(`a1`, { title: `something else entirely` })], 2);
        await nextTick();
        expect(filter.matches(useAgents().fleet.value[0] as FleetAgent)).toBe(false);
    });

    it(`surfaces archived matches, which are off the roster entirely`, async () => {
        setAgents([agent(`a1`, { title: `tidy the readme` })], 1);
        useAgents().archived.value = [
            { ...agent(`old`, { title: `the landAgent rewrite`, archivedAt: 2 }), open: false, unread: false, unsent: false },
        ];
        const filter = filterIn();
        filter.query.value = `landagent`;
        await settle();
        expect(filter.archivedMatches.value.map((match) => match.id)).toEqual([`old`]);
    });

    // A conversation a fleet agent owns must not be reported twice: once as its card and once as an
    // anonymous history row that opens the very same tab.
    it(`drops session matches that a fleet agent already carries`, async () => {
        setAgents([agent(`a1`, { title: `tidy the readme`, sessionId: `sess-1` })], 1);
        answers.sessions = {
            sessions: [
                { id: `sess-1`, title: `tidy the readme`, updatedAt: 1 },
                { id: `sess-9`, title: `an old plain chat`, updatedAt: 1, snippet: { text: `about landAgent`, speaker: `agent` } },
            ],
        };
        const filter = filterIn();
        filter.query.value = `landagent`;
        await settle();
        expect(filter.sessionMatches.value.map((session) => session.id)).toEqual([`sess-9`]);
    });
});
