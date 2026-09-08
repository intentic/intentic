import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same module-eval cuts useAgents.test.ts makes: importing the fleet store pulls in the router, analytics and sandbox
// modules, which read environment.ts's `window.env` at import time.
vi.mock("../../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
// The roster's own report when it catches itself behind (auditRoster) posts through sandboxTarget, another of those
// import-time reads.
vi.mock("../../../app/clientDiagnostics", () => ({ reportClient: vi.fn() }));
vi.mock("../../sandbox/client/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(`sbx-1`), reachable: ref(true) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
// These cases run on fake timers, so useChat's hydrate watch actually runs here; the registered placeholder has an
// empty transcript and other requests answer 404, irrelevant to the filter but must not unlatch `registered`.
vi.mock("../../sandbox/client/sandboxClient", () => ({
    sandboxJson: vi.fn(async () => ({})),
    sandboxRequest: vi.fn(async (path: string) =>
        path === `/agents/blank/transcript`
            ? { ok: true, status: 200, body: null, json: async () => ({ messages: [] }) }
            : { ok: false, status: 404, body: null },
    ),
}));

// The daemon tier, stubbed at the useQuery seam: what's under test is the merge, which tier answers and what evidence
// it produces, not TanStack's fetching.
const answers = { agents: undefined as unknown, sessions: undefined as unknown };
// The keys the composable asked under, kept live, since re-asking on a match-case flip is part of what's tested.
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
import { Conversation } from "../../chat/session/conversation";
import { useChat } from "../../chat/run/useChat";
import { useAgentFilter } from "./useAgentFilter";
import { resetAgents, useAgents } from "../fleet/useAgents";
import type { FleetAgent } from "../fleet/useAgents-fleet";
import { setAgents } from "../fleet/useAgents-registry";

const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const agent = (id: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
    id,
    status: `idle`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1,
    attention: none,
    ...extra,
});

// The composable debounces its daemon tier by 150ms; the local tier answers on the tick. Waits out the timer so the
// stubbed answer is considered current.
const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
};

// useChat always has an active conversation; each case gets one non-isolated placeholder to stand in for it, since an
// isolated one with no registry entry would be a draft card and skew every count here.
const placeholder = (): Conversation => {
    const blank = new Conversation(`blank`);
    blank.isolated.value = false;
    blank.registered.value = true;
    return blank;
};

// The composable runs inside an effect scope, as a component's setup would: it registers a debounce watcher and
// onScopeDispose, which a bare call would warn about and leak.
let scope: EffectScope | undefined;
let current: ReturnType<typeof useAgentFilter> | undefined;
const filterIn = (): ReturnType<typeof useAgentFilter> => {
    scope = effectScope();
    current = scope.run(() => useAgentFilter()) as ReturnType<typeof useAgentFilter>;
    return current;
};

afterEach(() => {
    // `matchCase` is one preference behind every field, written through to storage, so a case left on leaks into the
    // next test.
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
        // The card already shows the title it matched on; repeating it as a snippet would be noise.
        expect(filter.snippetOf(first as FleetAgent)).toBeUndefined();
    });

    // The point of the local tier: an open tab needs no round trip and answers on the keystroke.
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
        // Both sides said "landAgent" here, and the line shown is the user's own, since a query is typed from memory of
        // one's own phrasing.
        expect(filter.snippetOf(target)).toEqual({ text: `actually make it use landAgent instead`, speaker: `user` });
    });

    // A reply quoted under a card reads as the user's unless the row says whose words they were.
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

    // A notice is neither side speaking: something happened to the turn, so it's not searchable.
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

    // The tiers are a union over one agent, never two rows or two snippets: the local answer, being provable, wins.
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

    // The Aa switch, on the tier that answers first: off, letters don't matter and both cards stay; on, the query
    // stands as typed.
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

    // The daemon tier is asked under the same case rule, or the half of the fleet this browser never opened would be
    // matched under the other one.
    it(`carries the case rule to the daemon, and re-asks the moment it is flipped`, async () => {
        setAgents([agent(`a1`, { title: `tidy the readme` })], 1);
        const filter = filterIn();
        filter.query.value = `FROM`;
        await settle();
        expect(keys.every((key) => !String(unref(key)).includes(`caseSensitive`))).toBe(true);

        // Flipping the switch re-folds the term and re-asks; until it settles, the composable's own guard holds back
        // the daemon's older answer.
        filter.matchCase.value = true;
        await settle();
        // Both tiers' keys, the fleet's and the never-carded sessions', or rows found under the old rule would still be
        // listed.
        expect(keys.map((key) => String(unref(key))).filter((key) => key.includes(`query=FROM&caseSensitive=true`))).toHaveLength(2);
    });

    // The board memoises a card on this snippet (`v-memo`); an equal-but-new object every call would read as a change
    // and redraw every matched card on every roster frame.
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

        // The board asks about seven times per render; every one has to get the same answer, not a new object.
        expect(filter.snippetOf(target)).toBe(first);

        // ...and across a rebuild of the local index, which every streaming frame causes: the quoted line is untouched,
        // so the hit is the same hit.
        conversation.restoreMessages([
            { role: `user`, text: `the landAgent bug` },
            { role: `assistant`, text: `looking at it now` },
        ]);
        await nextTick();
        expect(filter.snippetOf(target)).toBe(first);
    });

    // ...but a rename is a real change of input, and the memo must not keep answering for the name it cached under.
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

    // A conversation a fleet agent already carries must not be reported twice, once as its card and once as an
    // anonymous history row.
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
