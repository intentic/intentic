import { beforeEach, describe, expect, it, vi } from "vitest";

// canArchive is pure, but the fleet store it lives beside pulls useChat and the app shell at import time. These
// mocks cut the edges that reach `window.env` (router, analytics, sandbox client) without touching what's tested.
vi.mock("../../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
vi.mock("../../sandbox/client/useSandbox", async () => {
    const { ref } = await import("vue");
    return { useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }) };
});
// Pins the scoping rule to a fixed id so assertions below can spell out the whole key.
vi.mock("../../sandbox/overview/activeSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`] }));
vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));
// And the fourth: auditRoster reports through sandboxTarget, which reads window.env on import.
vi.mock("../../../app/clientDiagnostics", () => ({ reportClient: vi.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { sandboxJson, sandboxRequest } from "../../sandbox/client/sandboxClient";
import { nextTick } from "vue";
import { forgetClosedDraft, keepClosedDraft } from "../../chat/drafts/closedDrafts";
import { Conversation } from "../../chat/session/conversation";
import type { Strip, TabFacts } from "../../chat/tabs/tabFacts";
import { useChat } from "../../chat/run/useChat";
import { useNotifications } from "../../../shell/notifications/notifications";
import { queryClient } from "../../../lib/queryPersistence";
import { resetAgents, useAgents } from "./useAgents";
import { canArchive, FINISHED_WINDOW, type FleetAgent, windowFinished } from "./useAgents-fleet";
import { auditRoster, resetArchive, setAgents } from "./useAgents-registry";

// The Finished lane's cap, and the one card it may never drop: the board's selection ring points at whatever the
// docked chat shows, so culling that card would leave the ring nowhere.
describe("windowFinished", () => {
    const lane = (count: number): FleetAgent[] =>
        Array.from({ length: count }, (_, at) => ({
            id: `a${at}`,
            status: `landed` as const,
            provider: `claude` as const,
            harness: `native` as const,
            updatedAt: 1_000 - at,
            attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
            open: false,
            unread: false,
            unsent: false,
        }));
    const ids = (agents: readonly FleetAgent[]): string[] => agents.map((agent) => agent.id);
    // The board reads its own id; the chat list reaches through a wrapper, hence a reader function, not a type.
    const byId = (agent: FleetAgent): string => agent.id;

    it("shows a short lane whole, with nothing to collapse", () => {
        expect(windowFinished(lane(3), undefined, byId)).toEqual({ shown: lane(3), hidden: 0 });
    });

    it("caps a long lane at the window and counts out the rest", () => {
        const { shown, hidden } = windowFinished(lane(10), undefined, byId);

        expect(shown).toHaveLength(FINISHED_WINDOW);
        expect(hidden).toBe(4);
    });

    it("keeps the selected card whatever its age: pinned at the tail, and counted OUT of the row that hides the rest", () => {
        const { shown, hidden } = windowFinished(lane(10), `a8`, byId);

        expect(ids(shown)).toEqual([`a0`, `a1`, `a2`, `a3`, `a4`, `a5`, `a8`]);
        // Seven cards on screen out of ten: the row below may only claim the three it actually hides.
        expect(hidden).toBe(3);
    });

    it("leaves the lane alone when the selection is already inside the window: no card is ever shown twice", () => {
        expect(windowFinished(lane(10), `a2`, byId)).toEqual(windowFinished(lane(10), undefined, byId));
    });

    it("leaves it alone for a selection this lane does not hold: an active agent, an archived one, a plain chat", () => {
        expect(windowFinished(lane(10), `nowhere`, byId)).toEqual(windowFinished(lane(10), undefined, byId));
    });

    it("drops the tail row entirely when the pin was the only card behind it", () => {
        // Seven cards, so `a6` is the only one past the window, and it is the pin: nothing is left to claim.
        const { shown, hidden } = windowFinished(lane(7), `a6`, byId);

        expect(ids(shown)).toEqual([`a0`, `a1`, `a2`, `a3`, `a4`, `a5`, `a6`]);
        expect(hidden).toBe(0);
    });

    // The id lives one level down, on the wrapped conversation, the case the extractor exists for that a
    // `T extends { id }` constraint could not reach.
    it("windows entries whose id is not their own field: the chat list's wrapped conversations", () => {
        const chats = lane(10).map((agent) => ({ conversation: { conversationId: agent.id } }));
        const { shown, hidden } = windowFinished(chats, `a8`, (entry) => entry.conversation.conversationId);

        expect(shown.map((entry) => entry.conversation.conversationId)).toEqual([`a0`, `a1`, `a2`, `a3`, `a4`, `a5`, `a8`]);
        expect(hidden).toBe(3);
    });
});

// The board's exit gate is not the Finished lane: gating on it stranded a failed turn with nothing to land, so it
// was neither archivable nor finishable. The line that matters is whether archiving would bury something awaited.
describe("canArchive", () => {
    const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

    it("takes the dead ends: a failed turn and an unlandable conflict are exactly what wants taking off the board", () => {
        expect(canArchive({ status: `error`, attention: none })).toBe(true);
        expect(canArchive({ status: `conflict`, attention: { ...none, conflict: true } })).toBe(true);
        expect(canArchive({ status: `idle`, attention: { ...none, conflict: true } })).toBe(true);
    });

    it("takes the routine case the Finished lane already offered", () => {
        expect(canArchive({ status: `landed`, attention: none })).toBe(true);
        expect(canArchive({ status: `idle`, attention: none })).toBe(true);
    });

    it("refuses an agent waiting to be told something: archiving would bury the question, not answer it", () => {
        expect(canArchive({ status: `awaiting`, attention: none })).toBe(false);
        expect(canArchive({ status: `running`, attention: { ...none, plan: true } })).toBe(false);
        expect(canArchive({ status: `running`, attention: { ...none, question: true } })).toBe(false);
        expect(canArchive({ status: `running`, attention: { ...none, permission: true } })).toBe(false);
    });

    it("refuses a live turn (the worktree is its working state) and a draft (no registry entry to archive)", () => {
        expect(canArchive({ status: `running`, attention: none })).toBe(false);
        expect(canArchive({ status: `draft`, attention: none })).toBe(false);
        // A refused send is in Attention with no entry to file; its affordance is Close, not Archive.
        expect(canArchive({ status: `failed`, attention: none })).toBe(false);
        // A stopped turn is still live until its generator unwinds; the daemon holds the worktree the whole time.
        expect(canArchive({ status: `stopping`, attention: none })).toBe(false);
    });

    // Once stopped it's a dead end like any other: half-written work, nothing outstanding, safe to archive.
    it("takes a turn the user stopped", () => {
        expect(canArchive({ status: `stopped`, attention: none })).toBe(true);
    });

    it("refuses one that is already archived, so the card offers Restore instead of a second Archive", () => {
        expect(canArchive({ status: `landed`, attention: none, archivedAt: 1_000 })).toBe(false);
    });
});

// An open tab follows the roster's title: seed-once ownership broke once the daemon could promote a title itself,
// or another device could rename it.
describe("roster titles", () => {
    const registered = (id: string, title?: string): AgentSummary => ({
        id,
        status: `running`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        ...(title !== undefined ? { title } : {}),
    });

    // Each case installs the one tab it's about; the list is never emptied, since useChat guarantees an active
    // conversation at all times.
    beforeEach(() => {
        resetAgents();
    });

    it("repaints an open tab when the daemon promotes its title", async () => {
        const promoted = `Fix the login submit handler`;
        const conversation = new Conversation(`a1`);
        conversation.title.value = `The login page throws on submit`;
        useChat().conversations.value = [conversation];

        setAgents([registered(`a1`, promoted)], 1);
        await nextTick();

        expect(conversation.title.value).toBe(promoted);
    });

    it("leaves a tab that named itself alone while its entry carries no title", async () => {
        // No title yet means the turn hasn't started; adopting that would blank a tab already titled from the prompt.
        const conversation = new Conversation(`a1`);
        conversation.title.value = `The login page throws on submit`;
        useChat().conversations.value = [conversation];

        setAgents([registered(`a1`)], 1);
        await nextTick();

        expect(conversation.title.value).toBe(`The login page throws on submit`);
    });
});

// AgentsView memoizes each card on the object it's handed (v-memo); a frame that changed nothing about an agent
// must hand back the same object, or every lane re-renders every card each tick.
describe("roster frames the board can skip", () => {
    const summary = (id: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
        id,
        status: `running`,
        provider: `claude`,
        harness: `native`,
        // seenAt outruns updatedAt so nothing here reads as unread; object identity is what's under test.
        updatedAt: 1_000,
        seenAt: 2_000,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        ...extra,
    });
    const cardsById = (): Map<string, FleetAgent> => new Map(useAgents().fleet.value.map((card) => [card.id, card]));

    beforeEach(() => {
        resetAgents();
    });

    it("hands back the identical cards when a frame said nothing new", async () => {
        setAgents([summary(`a1`), summary(`a2`)], 1);
        await nextTick();
        const before = useAgents().fleet.value;
        const wasA1 = cardsById().get(`a1`);

        // The same roster again, freshly off the wire: every object is new, nothing it says has changed.
        setAgents([summary(`a1`), summary(`a2`)], 2);
        await nextTick();

        // The array too, not just its entries, so `lanes` never re-groups and the board never re-renders.
        expect(useAgents().fleet.value).toBe(before);
        expect(cardsById().get(`a1`)).toBe(wasA1);
    });

    // What a moving frame may re-mint is covered by the diff-invalidation cases; this pins the stronger guarantee
    // underlying the comparison itself.

    // The cached fingerprint isn't stored: optimistic writes mutate the held entry in place, so a stored string would
    // describe the pre-write entry and mask a value the daemon later refused.
    it("lets a later frame overrule an optimistic write still in flight", async () => {
        setAgents([summary(`a1`, { title: `Old name` })], 1);
        await nextTick();

        // The request never settles, so the board holds only the in-place optimistic write.
        vi.mocked(sandboxJson).mockImplementation(() => new Promise(() => undefined));
        void useAgents().rename(`a1`, `New name`);
        await nextTick();
        expect(cardsById().get(`a1`)?.title).toBe(`New name`);

        // A frame that still disagrees puts the roster back on the daemon's own account.
        setAgents([summary(`a1`, { title: `Old name` })], 2);
        await nextTick();
        expect(cardsById().get(`a1`)?.title).toBe(`Old name`);
    });
});

// The beat's audit: a roster frame that never applied leaves the board silently frozen until reload. The
// heartbeat states its revision, sent only when the queue is empty, so a mismatch is proof, not a race.
describe("the beat's audit of the roster", () => {
    const summary = (id: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
        id,
        status: `running`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        seenAt: 2_000,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        ...extra,
    });
    const asking = (id: string): AgentSummary =>
        summary(id, {
            status: `awaiting`,
            attention: { plan: false, question: true, permission: false, capability: false, credential: false, conflict: false },
        });
    // What the roster says about one agent right now, the whole of what a stale board gets wrong.
    const parked = (id: string): boolean => useAgents().fleet.value.find((card) => card.id === id)?.attention.question === true;
    const answers = (agents: AgentSummary[], rev: number): void => {
        vi.mocked(sandboxJson).mockResolvedValue({ agents, rev });
    };

    beforeEach(() => {
        resetAgents();
        vi.mocked(sandboxJson).mockReset();
    });

    it("asks for nothing while the beat agrees with what it holds", async () => {
        setAgents([asking(`a1`)], 7);
        await nextTick();

        auditRoster(7);
        await nextTick();

        expect(sandboxJson).not.toHaveBeenCalled();
    });

    it("reads the roster back when the beat is ahead: the frame in between never landed", async () => {
        setAgents([asking(`a1`)], 7);
        await nextTick();
        expect(parked(`a1`)).toBe(true);
        // The answer the board never heard: the question is settled and the agent is working again.
        answers([summary(`a1`)], 8);

        auditRoster(8);
        await vi.waitFor(() => expect(parked(`a1`)).toBe(false));

        expect(sandboxJson).toHaveBeenCalledWith(`/agents`);
    });

    // A revision lower than the one held can't be repaired by a plain pull, since the guard would drop the pull's own
    // answer too. The daemon owns its revision line, so it's adopted instead of defended.
    it("adopts a revision line that moved backwards instead of defending the one it holds", async () => {
        setAgents([asking(`a1`)], 50);
        await nextTick();
        answers([summary(`a1`)], 4);

        auditRoster(3);
        await vi.waitFor(() => expect(parked(`a1`)).toBe(false));
    });

    it("keeps one read in flight, however many beats disagree while it runs", async () => {
        setAgents([asking(`a1`)], 7);
        await nextTick();
        answers([summary(`a1`)], 9);

        auditRoster(8);
        auditRoster(9);
        auditRoster(9);
        await vi.waitFor(() => expect(parked(`a1`)).toBe(false));

        expect(vi.mocked(sandboxJson).mock.calls.filter(([path]) => path === `/agents`)).toHaveLength(1);
    });
});

// The diff query is pull-only while the roster is push-fed, so a status transition is the one signal that a land
// performed elsewhere changed what the query holds.
describe("diff invalidation", () => {
    // seenAt outruns updatedAt so nothing here reads unread; this suite is about invalidation, not read markers.
    const summary = (id: string, status: AgentSummary["status"]): AgentSummary => ({
        id,
        status,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        seenAt: 2_000,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });

    beforeEach(() => {
        resetAgents();
    });

    it("invalidates an agent's diff on a status transition: the auto-land flip this browser never performed", () => {
        setAgents([summary(`a1`, `running`)], 1);
        const invalidate = vi.spyOn(queryClient, `invalidateQueries`).mockResolvedValue();

        setAgents([summary(`a1`, `landed`)], 2);

        expect(invalidate).toHaveBeenCalledWith({ queryKey: [`agents`, `a1`, `diff`, `sbx-1`] });
        invalidate.mockRestore();
    });

    it("stays quiet across frames that only tick activity: a running turn must not hammer the diff", () => {
        setAgents([summary(`a1`, `running`)], 1);
        const invalidate = vi.spyOn(queryClient, `invalidateQueries`).mockResolvedValue();

        setAgents([{ ...summary(`a1`, `running`), updatedAt: 2_000 }], 2);

        expect(invalidate).not.toHaveBeenCalled();
        invalidate.mockRestore();
    });

    it("reuses fleet entries across frames that only tick another agent: the board must not replace every card", () => {
        setAgents([summary(`a1`, `landed`), summary(`a2`, `running`)], 1);
        const { fleet } = useAgents();
        const before = fleet.value;

        setAgents([summary(`a1`, `landed`), { ...summary(`a2`, `running`), updatedAt: 2_000 }], 2);

        expect(fleet.value.find((agent) => agent.id === `a1`)).toBe(before.find((agent) => agent.id === `a1`));
        expect(fleet.value.find((agent) => agent.id === `a2`)).not.toBe(before.find((agent) => agent.id === `a2`));
    });

    it("treats an unseen id as a transition: a reconnect's first snapshot may carry a land that happened offline", () => {
        const invalidate = vi.spyOn(queryClient, `invalidateQueries`).mockResolvedValue();

        setAgents([summary(`a1`, `landed`)], 0);

        expect(invalidate).toHaveBeenCalledWith({ queryKey: [`agents`, `a1`, `diff`, `sbx-1`] });
        invalidate.mockRestore();
    });
});

// A draft is the fleet's one client-only card, latched as a one-way rule (never registered) rather than derived
// from "absent on the live roster", which also matched archived agents and every agent while the stream was down.
describe("draft cards", () => {
    const registered = (id: string): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });

    // The lane the phantom card landed in, by id, so a case can say which agent rather than merely how many.
    const activeIds = (): string[] => useAgents().lanes.value.active.map((entry) => entry.id);

    // One tab of a popped-out chat's strip, as the drawing window would publish it (tabFacts).
    const draftTab = (id: string, words?: string, at?: number): TabFacts => ({
        id,
        registered: false,
        standing: `draft`,
        peek: false,
        // A user-requested draft; the panel-only blank (`standIn`) is the case below, drawing no card at all.
        standIn: false,
        provider: `claude`,
        harness: `native`,
        model: ``,
        unsent: words !== undefined,
        ...(words === undefined ? {} : { preview: words }),
        ...(at === undefined ? {} : { draftAt: at }),
    });
    let stripRevision = 0;
    const strip = (...tabs: TabFacts[]): Strip => ({ active: tabs[0]?.id, panes: tabs.slice(0, 1).map((tab) => tab.id), tabs });

    beforeEach(() => {
        // These cases drive the real open path, firing the daemon's best-effort side calls (read marker, attach probe);
        // both are stubbed to resolve, since an undefined return isn't something either knows how to survive.
        vi.mocked(sandboxJson)
            .mockReset()
            .mockResolvedValue({} as never);
        vi.mocked(sandboxRequest)
            .mockReset()
            .mockResolvedValue({ ok: false } as never);
        resetAgents();
        useAgents().archived.value = [];
        // One open tab per case, installed by the case itself; this registered placeholder keeps useChat's
        // always-one-active-conversation invariant without acting as another draft under test.
        const other = new Conversation();
        other.isolated.value = false;
        other.registered.value = true;
        useChat().conversations.value = [other];
    });

    it("cards an isolated conversation the fleet has never seen, so New agent lands on the board at once", () => {
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`fresh`)];

        expect(activeIds()).toEqual([`fresh`]);
    });

    // Draws nothing for the blank a close leaves behind (Conversation.standIn), a different thing from a real draft:
    // carding it put a "New agent" wearing the selection ring the moment the last chat closed.
    it("draws no card for the blank left standing when the last chat closes", () => {
        const chat = useChat();

        chat.closeTabs(new Set(chat.conversations.value.map((conversation) => conversation.conversationId)));

        // The panel kept its one conversation, and the board is empty: nothing started, nothing carded.
        expect(chat.conversations.value).toHaveLength(1);
        expect(activeIds()).toEqual([]);
    });

    // It becomes a card again the instant it stands for something the user did; nothing else marks the promotion
    // (tabFacts.unasked).
    it("cards that blank once words land in it", async () => {
        const chat = useChat();
        chat.closeTabs(new Set(chat.conversations.value.map((conversation) => conversation.conversationId)));
        const blank = chat.active.value;

        blank.draft.value = `fix the login redirect`;
        await nextTick();

        expect(activeIds()).toEqual([blank.conversationId]);
    });

    // A chat closed with its message still in it has no tab and no roster row, so this card is the only way the words
    // stay visible; it stands where the tab stood, named by the message.
    it("cards a draft whose chat was closed with the message still in it", () => {
        keepClosedDraft({
            conversationId: `set-aside`,
            isolated: true,
            registered: false,
            provider: `claude`,
            harness: `native`,
            model: `claude-opus-5`,
            draft: `fix the login redirect`,
            draftAt: 1_700,
            attachments: [],
            queued: [],
        });

        expect(
            useAgents().lanes.value.active.map((card) => ({
                id: card.id,
                status: card.status,
                open: card.open,
                unsent: card.unsent,
                preview: card.preview,
                draftAt: card.draftAt,
                model: card.model,
                updatedAt: card.updatedAt,
            })),
        ).toEqual([
            {
                id: `set-aside`,
                status: `draft`,
                // No tab holds it, which is what the card is for; its × forgets it rather than closing it.
                open: false,
                unsent: true,
                preview: `fix the login redirect`,
                draftAt: 1_700,
                model: `claude-opus-5`,
                // Undated like every card the daemon has no row for: the mark ages the message, not activity.
                updatedAt: 0,
            },
        ]);

        forgetClosedDraft(`set-aside`);
    });

    // It gives way to the tab the instant one exists; drawing both would show the same message twice.
    it("draws one card, not two, when the chat is open again", () => {
        keepClosedDraft({
            conversationId: `set-aside`,
            isolated: true,
            registered: false,
            draft: `fix the login redirect`,
            attachments: [],
            queued: [],
        });
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`set-aside`)];

        expect(activeIds()).toEqual([`set-aside`]);

        forgetClosedDraft(`set-aside`);
    });

    it("cards a workspace conversation by the same rule", () => {
        const conversation = new Conversation(`workspace-fresh`);
        conversation.isolated.value = false;
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(activeIds()).toEqual([`workspace-fresh`]);
    });

    // An unnamed card is called by the opening words waiting in it, since a title is minted only by the first turn.
    it("names a draft card after the words waiting in its composer", () => {
        const conversation = new Conversation(`fresh`);
        conversation.draft.value = `fix the login redirect`;
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(useAgents().lanes.value.active.map((card) => ({ id: card.id, preview: card.preview, unsent: card.unsent }))).toEqual([
            { id: `fresh`, preview: `fix the login redirect`, unsent: true },
        ]);
    });

    // A prepared draft's model shows on its card immediately, following its own conversation, so picking a model in
    // one draft moves only that card.
    it("names the model a prepared draft will run on, and moves only that card when it is picked", () => {
        const first = new Conversation(`prepared`);
        first.draft.value = `fix the login redirect`;
        first.selectModel({ provider: `cursor`, value: `composer-2.5` });
        const second = new Conversation(`beside`);
        second.draft.value = `write the release notes`;
        second.selectModel({ provider: `claude`, value: `claude-opus-5` });
        useChat().conversations.value = [...useChat().conversations.value, first, second];

        const shown = (): { id: string; provider: string; model: string | undefined }[] =>
            useAgents()
                .lanes.value.active.map((card) => ({ id: card.id, provider: card.provider, model: card.model }))
                .toSorted((a, b) => a.id.localeCompare(b.id));

        expect(shown()).toEqual([
            { id: `beside`, provider: `claude`, model: `claude-opus-5` },
            { id: `prepared`, provider: `cursor`, model: `composer-2.5` },
        ]);

        // One draft re-pointed at another provider's model: its card follows at once, the other holds still.
        first.selectModel({ provider: `claude`, value: `claude-sonnet-4-5-20250929` });

        expect(shown()).toEqual([
            { id: `beside`, provider: `claude`, model: `claude-opus-5` },
            { id: `prepared`, provider: `claude`, model: `claude-sonnet-4-5-20250929` },
        ]);
    });

    // An untouched tab names no model, since nothing has been decided about it yet.
    it("leaves an untouched New agent card unpriced", () => {
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`fresh`)];

        expect(useAgents().lanes.value.active.map((card) => card.model)).toEqual([undefined]);
    });

    // A draft typed in the popped-out chat looks untouched over here, so clicking another card used to sweep it away;
    // the board reads the drawing window's own published strip (chatEcho) instead.
    it("draws a draft, named and marked, from the popped-out chat's strip, whatever this window holds", async () => {
        const { receiveChatNote } = await import("../../chat/run/chatChannel");
        const { receiveFloatingNote } = await import("../../../shell/window/floating");
        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
        // This window's own strip is empty of it; the card is drawn from the other window's note anyway.
        receiveChatNote({
            sandbox: undefined,
            note: { kind: `strip`, owner: `w1`, revision: ++stripRevision, strip: strip(draftTab(`fresh`, `fix the login redirect`, 1_700)) },
        });

        // The age comes off the strip too; guessing here would report this window's own boot time instead.
        expect(
            useAgents().lanes.value.active.map((card) => ({
                id: card.id,
                preview: card.preview,
                unsent: card.unsent,
                draftAt: card.draftAt,
                open: card.open,
            })),
        ).toEqual([{ id: `fresh`, preview: `fix the login redirect`, unsent: true, draftAt: 1_700, open: true }]);

        receiveChatNote({ sandbox: undefined, note: { kind: `strip`, owner: `w1`, revision: ++stripRevision, strip: strip() } });
        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });
    });

    // A window not drawing the chat keeps its tab frozen at whatever was in the composer when the panel left; this
    // window can't clear a mark for a composer it never sees, so it must trust the drawing window's own strip.
    it("drops the mark when the popped-out chat says the message went, whatever this window's frozen tab holds", async () => {
        const { receiveChatNote } = await import("../../chat/run/chatChannel");
        const { receiveFloatingNote } = await import("../../../shell/window/floating");
        setAgents([registered(`a1`)], 0);
        const conversation = new Conversation(`a1`);
        conversation.registered.value = true;
        conversation.draft.value = `fix the login redirect`;
        useChat().conversations.value = [...useChat().conversations.value, conversation];
        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
        receiveChatNote({
            sandbox: undefined,
            note: {
                kind: `strip`,
                owner: `w1`,
                revision: ++stripRevision,
                strip: strip({ ...draftTab(`a1`, `fix the login redirect`), registered: true, standing: `resumed` }),
            },
        });
        expect(useAgents().lanes.value.finished.map((card) => card.unsent)).toEqual([true]);

        // Sent out there: the holder's next strip carries the tab without words; this window's own copy was stale.
        receiveChatNote({
            sandbox: undefined,
            note: {
                kind: `strip`,
                owner: `w1`,
                revision: ++stripRevision,
                strip: strip({ ...draftTab(`a1`), registered: true, standing: `resumed` }),
            },
        });

        expect(useAgents().lanes.value.finished.map((card) => ({ id: card.id, unsent: card.unsent }))).toEqual([{ id: `a1`, unsent: false }]);

        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });
    });

    // The rail's × removes the chat from that surface only; the floating window sets the message aside, then drops
    // the tab, and the board reads both as one continuous card.
    it("turns a draft card into a set-aside card in one step when the popped-out chat closes it", async () => {
        const { receiveChatNote } = await import("../../chat/run/chatChannel");
        const { receiveFloatingNote } = await import("../../../shell/window/floating");
        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
        receiveChatNote({
            sandbox: undefined,
            note: { kind: `strip`, owner: `w1`, revision: ++stripRevision, strip: strip(draftTab(`fresh`, `fix the login redirect`, 1_700)) },
        });
        const card = (): { id: string; open: boolean; unsent: boolean; preview: string | undefined; updatedAt: number }[] =>
            useAgents().lanes.value.active.map((entry) => ({
                id: entry.id,
                open: entry.open,
                unsent: entry.unsent,
                preview: entry.preview,
                updatedAt: entry.updatedAt,
            }));
        expect(card()).toEqual([{ id: `fresh`, open: true, unsent: true, preview: `fix the login redirect`, updatedAt: 0 }]);

        // First the words are set aside (closeTabs), before the tab itself is dropped.
        receiveChatNote({
            sandbox: undefined,
            note: {
                kind: `closed-drafts`,
                tabs: [
                    {
                        conversationId: `fresh`,
                        isolated: true,
                        registered: false,
                        provider: `claude`,
                        harness: `native`,
                        draft: `fix the login redirect`,
                        draftAt: 1_700,
                        attachments: [],
                        queued: [],
                    },
                ],
            },
        });
        expect(card()).toEqual([{ id: `fresh`, open: true, unsent: true, preview: `fix the login redirect`, updatedAt: 0 }]);

        // Then the tab is gone from the strip: the card stands for the message alone, undated.
        receiveChatNote({ sandbox: undefined, note: { kind: `strip`, owner: `w1`, revision: ++stripRevision, strip: strip() } });
        expect(card()).toEqual([{ id: `fresh`, open: false, unsent: true, preview: `fix the login redirect`, updatedAt: 0 }]);

        forgetClosedDraft(`fresh`);
        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });
    });

    // `preview`/`draftAt` are not confined to nameless cards: a titled agent's half-written follow-up needs the same
    // mark tooltip (UnsentMark), naming which message and how old.
    it("carries the message's words and its age on a card that has a title of its own", () => {
        setAgents([registered(`a1`)], 0);
        const conversation = new Conversation(`a1`);
        conversation.registered.value = true;
        conversation.draft.value = `and one more thing`;
        conversation.draftAt.value = 1_700;
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(useAgents().lanes.value.finished.map((card) => ({ preview: card.preview, draftAt: card.draftAt }))).toEqual([
            { preview: `and one more thing`, draftAt: 1_700 },
        ]);
    });

    // A conversation whose send was refused has no registry entry, but reading that as a draft put an unactionable
    // card above genuinely working agents; it belongs in Attention as `failed`, closable.
    it("cards a conversation whose send was refused as failed, in Attention rather than among the working", () => {
        const conversation = new Conversation(`refused`);
        conversation.error.value = `invalid attachment path: nope.png`;
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(activeIds()).toEqual([]);
        expect(useAgents().lanes.value.attention.map((entry) => ({ id: entry.id, status: entry.status }))).toEqual([
            { id: `refused`, status: `failed` },
        ]);
    });

    // The error is about the last send, not the conversation; a successful turn clears it.
    it("cards it as a draft again once a turn is under way", () => {
        const conversation = new Conversation(`refused`);
        conversation.error.value = `invalid attachment path: nope.png`;
        useChat().conversations.value = [...useChat().conversations.value, conversation];
        conversation.error.value = null;

        expect(activeIds()).toEqual([`refused`]);
    });

    // A sent turn the daemon hasn't filed yet is `starting`, carrying what the browser itself knows (model, elapsed)
    // instead of the bare wire fields a spinner used to show alone.
    it("cards a sent turn the fleet has not registered as starting, with the settings and elapsed it knows", () => {
        const conversation = new Conversation(`sent`);
        conversation.model.value = `claude-opus-5`;
        conversation.streaming.value = true;
        conversation.turnStartedAt.value = 4_000;
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(
            useAgents().lanes.value.active.map((card) => ({ id: card.id, status: card.status, model: card.model, startedAt: card.startedAt })),
        ).toEqual([{ id: `sent`, status: `starting`, model: `claude-opus-5`, startedAt: 4_000 }]);
    });

    // Opening a `starting` card latches it as registered, which used to make the drafts half skip it while the
    // registry had no entry yet, vanishing the agent from every lane.
    it("keeps a starting card on the board when it is opened, and leaves its placement alone", () => {
        const conversation = new Conversation(`sent`);
        conversation.streaming.value = true;
        useChat().conversations.value = [...useChat().conversations.value, conversation];
        const card = useAgents().lanes.value.active[0]!;

        useAgents().open(card);

        expect(conversation.registered.value).toBe(false);
        expect(conversation.isolated.value).toBe(true);
        expect(activeIds()).toEqual([`sent`]);
    });

    it("stops carding a conversation once the roster registers it: one card, from the registry", () => {
        const conversation = new Conversation(`a1`);
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        setAgents([registered(`a1`)], 1);

        expect(conversation.registered.value).toBe(true);
        expect(activeIds()).toEqual([]);
        expect(useAgents().lanes.value.finished.map((entry) => entry.id)).toEqual([`a1`]);
    });

    // Archiving from the board while its chat is open must close both views, not leave a phantom draft behind.
    it("takes the chat tab with the card, leaving nothing behind in either view", async () => {
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`a1`)];
        setAgents([registered(`a1`)], 1);
        vi.mocked(sandboxJson).mockResolvedValueOnce({ moved: [{ ...registered(`a1`), archivedAt: 2_000 }], failed: [], rev: 2 } as never);

        await useAgents().archive([`a1`]);

        expect(useChat().conversations.value.some((conversation) => conversation.conversationId === `a1`)).toBe(false);
        expect(activeIds()).toEqual([]);
        expect(useAgents().lanes.value.finished).toEqual([]);
        expect(useAgents().archived.value.map((entry) => entry.id)).toEqual([`a1`]);
    });

    // An archived agent keeps its branch/diff/transcript; opening it from the archive must not re-board it.
    it("leaves it off the board when its tab is opened from the archive", () => {
        const { archived, open } = useAgents();
        const entry = { ...registered(`a1`), archivedAt: 2_000 };
        archived.value = [{ ...entry, open: false, unread: false, unsent: false }];

        open(entry);

        expect(activeIds()).toEqual([]);
        expect(useChat().conversations.value.some((conversation) => conversation.conversationId === `a1`)).toBe(true);
    });

    // A dropped stream empties the roster wholesale; that must not turn every open tab into a fresh draft.
    it("does not turn every open agent tab into a draft when the stream drops", () => {
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`a1`)];
        setAgents([registered(`a1`)], 1);

        resetAgents();

        expect(activeIds()).toEqual([]);
    });

    // A conversation reopened from History has no registry entry either, but it isn't new work: carding it as a draft
    // put old history at the head of Active. Nothing is running or owed, so it's `finished`.
    it("cards a conversation reopened from History as an earlier chat, not as a fresh draft", () => {
        const conversation = new Conversation(`old-chat`);
        conversation.session.value = { id: `sess-1`, provider: `claude`, account: undefined, harness: `native` };
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(activeIds()).toEqual([]);
        expect(useAgents().lanes.value.finished.map((entry) => ({ id: entry.id, status: entry.status }))).toEqual([
            { id: `old-chat`, status: `resumed` },
        ]);
    });

    // An archived session with unsent words stays on the board for as long as those words exist, still marked
    // archived on its face; nothing is written daemon-side.
    it("lifts an archived session back onto the board while its chat holds an unsent message", () => {
        const { archived, open } = useAgents();
        const entry = { ...registered(`a1`), archivedAt: 2_000 };
        archived.value = [{ ...entry, open: false, unread: false, unsent: false }];
        open(entry);
        const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === `a1`)!;

        conversation.draft.value = `and one more thing —`;

        expect(useAgents().lanes.value.finished.map((card) => ({ id: card.id, unsent: card.unsent, archived: card.archivedAt }))).toEqual([
            { id: `a1`, unsent: true, archived: 2_000 },
        ]);
    });

    // It files back the moment the words clear; whitespace isn't a message, matching send()'s own rule.
    it("puts it back in the archive the moment the message is cleared", () => {
        const { archived, open } = useAgents();
        const entry = { ...registered(`a1`), archivedAt: 2_000 };
        archived.value = [{ ...entry, open: false, unread: false, unsent: false }];
        open(entry);
        const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === `a1`)!;
        conversation.draft.value = `and one more thing —`;

        conversation.draft.value = `   `;

        expect(useAgents().lanes.value.finished).toEqual([]);
    });
});

// The Finished lane windows to FINISHED_WINDOW cards, so an old session sits behind the fold until its chat gets
// unsent words, which move it ahead regardless of age.
describe("the finished fold", () => {
    const landed = (id: string, updatedAt: number): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    const shownIds = (): string[] => windowFinished(useAgents().lanes.value.finished, undefined, (entry) => entry.id).shown.map((entry) => entry.id);

    beforeEach(() => {
        resetAgents();
        useAgents().archived.value = [];
        const other = new Conversation();
        other.registered.value = true;
        useChat().conversations.value = [other];
    });

    // The reported case: the searched-up session is the oldest in the lane and folded away, until writing in it moves
    // it to the front.
    it("holds the oldest finished card in front of the fold when its chat has a message waiting", () => {
        const oldest = `a${FINISHED_WINDOW + 1}`;
        const conversation = new Conversation(oldest);
        conversation.registered.value = true;
        useChat().conversations.value = [...useChat().conversations.value, conversation];
        setAgents(
            Array.from({ length: FINISHED_WINDOW + 2 }, (_, at) => landed(`a${at}`, 1_000 - at)),
            1,
        );
        expect(shownIds()).not.toContain(oldest);

        conversation.draft.value = `picking this back up:`;

        expect(useAgents().lanes.value.finished[0]?.id).toBe(oldest);
        expect(shownIds()).toContain(oldest);
    });

    // Ordering, not pinning: unsent cards lead by recency among themselves, and past a window's worth the fold still
    // applies.
    it("orders every unsent card ahead of the sent ones", () => {
        const held = [`a6`, `a7`, `a8`].map((id) => {
            const conversation = new Conversation(id);
            conversation.registered.value = true;
            conversation.draft.value = `later`;
            return conversation;
        });
        useChat().conversations.value = [...useChat().conversations.value, ...held];

        setAgents(
            Array.from({ length: 9 }, (_, at) => landed(`a${at}`, 1_000 - at)),
            1,
        );

        expect(
            useAgents()
                .lanes.value.finished.slice(0, 3)
                .map((entry) => entry.id),
        ).toEqual([`a6`, `a7`, `a8`]);
    });

    // Sorts by how easily each is lost: unsent (lives only in this window), then unfinished work
    // (AgentSummary.unfinished), then ready-to-land, then recency.
    it("orders unfinished cards under the unsent ones and above the ones ready to land", () => {
        const writing = new Conversation(`a1`);
        writing.registered.value = true;
        writing.draft.value = `picking this back up:`;
        useChat().conversations.value = [...useChat().conversations.value, writing];

        setAgents(
            [
                landed(`a0`, 3_000),
                landed(`a1`, 1_000),
                { ...landed(`a2`, 2_000), status: `ready` },
                { ...landed(`a3`, 1_500), unfinished: { at: 900, steps: { open: 2, total: 5, next: `Cover it with tests` } } },
            ],
            1,
        );

        expect(useAgents().lanes.value.finished.map((entry) => entry.id)).toEqual([`a1`, `a3`, `a2`, `a0`]);
    });
});

// An unresolved tie falls to `fleet`'s own order, sorted by updatedAt; since that ticks per agent independently,
// tied cards reshuffled every frame. Ties are ordinary: a resumed batch shares one `startedAt`.
describe("lane order holds still", () => {
    const running = (id: string, startedAt: number, updatedAt: number): AgentSummary => ({
        id,
        status: `running`,
        provider: `claude`,
        harness: `native`,
        startedAt,
        updatedAt,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    const activeIds = (): string[] => useAgents().lanes.value.active.map((entry) => entry.id);

    beforeEach(() => {
        resetAgents();
        useAgents().archived.value = [];
        const other = new Conversation();
        other.registered.value = true;
        useChat().conversations.value = [other];
    });

    // Four agents resumed at once, each reporting its own activity, used to trade places every second; the lane must
    // settle on one order and hold it.
    it("holds agents that started in the same millisecond in place as their activity ticks", () => {
        const batch = [`c`, `a`, `d`, `b`];
        setAgents(
            batch.map((id) => running(id, 5_000, 5_000)),
            1,
        );
        const settled = activeIds();

        expect(settled).toHaveLength(4);
        // Each in turn becomes most recently active: the frames that used to re-deal the lane.
        for (const [at, live] of batch.entries()) {
            setAgents(
                batch.map((id) => running(id, 5_000, id === live ? 6_000 + at : 5_000)),
                at + 2,
            );

            expect(activeIds()).toEqual(settled);
        }
    });

    // Attention orders on updatedAt alone, so two agents asking at once tie outright too.
    it("holds the attention lane still when two cards share an updatedAt", () => {
        const asking = (id: string): AgentSummary => ({
            ...running(id, 5_000, 7_000),
            status: `awaiting`,
            attention: { plan: false, question: true, permission: false, capability: false, credential: false, conflict: false },
        });
        setAgents([asking(`b`), asking(`a`)], 1);
        const settled = useAgents().lanes.value.attention.map((entry) => entry.id);

        // The daemon's roster order is not a promise; the lane must not move just because it changed.
        setAgents([asking(`a`), asking(`b`)], 2);

        expect(useAgents().lanes.value.attention.map((entry) => entry.id)).toEqual(settled);
    });
});

// Archiving is the routine way an agent leaves the fleet: it never asks first, never interrupts, and always keeps
// a way back.
describe("archive", () => {
    const agent = (id: string): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    const archivedAgent = (id: string): AgentSummary => ({ ...agent(id), archivedAt: 2_000 });
    const post = vi.mocked(sandboxJson);
    // This suite's own agent tabs; reset also installs a main-tree chat no archive case is about.
    const openTabs = (): string[] =>
        useChat()
            .conversations.value.map((conversation) => conversation.conversationId)
            .filter((id) => [`a`, `b`].includes(id));

    // The store is a module singleton, so each case resets the roster, undo set and reports (promises about one
    // daemon) plus the tab strip, since archiving now writes to it.
    beforeEach(() => {
        // Stubbed to resolve by default: an archive fires the daemon's best-effort side calls, and undefined isn't
        // something they survive. Per-case mocks still take precedence.
        post.mockReset().mockResolvedValue({} as never);
        resetAgents();
        // The receipt is the app's shared channel; a desync must not wipe what else is on screen.
        useNotifications().dismissReceipt();
        useAgents().archived.value = [];
        const other = new Conversation();
        other.isolated.value = false;
        useChat().conversations.value = [other];
    });

    it("moves what the daemon says moved, and keeps a way back without saying a word", async () => {
        const { archive, notice, undoable, archivedFlash, lanes, archived } = useAgents();
        const { receipt } = useNotifications();
        setAgents([agent(`a`), agent(`b`)], 1);
        const flashes = archivedFlash.value;
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], failed: [], rev: 2 } as never);

        await archive([`a`]);

        expect(post).toHaveBeenCalledWith(`/agents/archive`, expect.objectContaining({ method: `POST`, body: JSON.stringify({ ids: [`a`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
        // Archive half fills from the same response, no second round-trip, so a cross-half lookup resolves at once.
        expect(archived.value.map((entry) => entry.id)).toEqual([`a`]);
        // The whole point of the rework: the routine single-card case interrupts nobody.
        expect(receipt.value).toBeUndefined();
        expect(notice.value).toBeUndefined();
        // Quiet isn't unrecoverable: the undo is held and the counter still pulses.
        expect(undoable.value).toEqual([`a`]);
        expect(archivedFlash.value).toBe(flashes + 1);
    });

    // Behind one press sit a commit, checkout teardown and ref park per repo, so the old code held the card still for
    // as long as git took. The card now leaves on the press; the daemon's answer only ever corrects it.
    describe("before the daemon has answered", () => {
        // A request left open on purpose, so assertions land in the frame the user actually sees.
        const held = <T>(): { answer: Promise<T>; give: (value: T) => void; refuse: (error: Error) => void } => {
            let give!: (value: T) => void;
            let refuse!: (error: Error) => void;
            const answer = new Promise<T>((resolve, reject) => {
                give = resolve;
                refuse = reject;
            });
            return { answer, give, refuse };
        };

        it("takes the card off the board on the press, and leaves it off when the archive lands", async () => {
            const { archive, lanes } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            const request = held<{ moved: AgentSummary[]; failed: never[]; rev: number }>();
            post.mockReturnValueOnce(request.answer as never);

            const press = archive([`a`]);

            // Not awaited: the daemon has said nothing yet, which is the whole point of the change.
            expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
            request.give({ moved: [archivedAgent(`a`)], failed: [], rev: 2 });
            await press;
            expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
        });

        it("slides the card back when the press fails, under the strip that says why", async () => {
            const { archive, lanes, notice } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockRejectedValueOnce(new Error(`the agent's turn is running`));

            await archive([`a`]);

            expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
            expect(notice.value).toContain(`the agent's turn is running`);
        });

        // The removal is only a guess: an agent the daemon declines (a turn that started under the press) must come
        // back,
        // while the rest stay gone.
        it("hands back exactly what the daemon declined", async () => {
            const { archive, lanes, archived, undoable } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], failed: [], rev: 2 } as never);

            await archive([`a`, `b`]);

            expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
            expect(archived.value.map((entry) => entry.id)).toEqual([`a`]);
            expect(undoable.value).toEqual([`a`]);
        });

        // "Nothing moved" is the case the optimistic removal got entirely wrong, so the board goes back whole.
        it("puts the whole lane back when nothing moved", async () => {
            const { archive, lanes } = useAgents();
            const { receipt } = useNotifications();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [], failed: [], rev: 2 } as never);

            await archive();

            expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
            expect(receipt.value?.title).toContain(`Nothing to archive`);
        });

        // A refusal (deleted repo, locked checkout) answers 200 with nothing moved; the daemon now names what and why,
        // on
        // the persistent strip rather than as a false "nothing to archive".
        it("says why the daemon refused, instead of claiming there was nothing to archive", async () => {
            const { archive, lanes, notice } = useAgents();
            const { receipt } = useNotifications();
            setAgents([agent(`a`)], 1);
            post.mockResolvedValueOnce({
                moved: [],
                failed: [{ id: `a`, reason: `fatal: not a git repository` }],
                rev: 2,
            } as never);

            await archive([`a`]);

            expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`a`]);
            expect(notice.value).toContain(`git repository`);
            expect(receipt.value).toBeUndefined();
        });

        // A mixed answer keeps the refused card's explanation instead of wiping it as "archive worked".
        it("keeps the refusal on screen when the rest of the press succeeded", async () => {
            const { archive, lanes, notice } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({
                moved: [archivedAgent(`b`)],
                failed: [{ id: `a`, reason: `worktree busy` }],
                rev: 2,
            } as never);

            await archive([`a`, `b`]);

            expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`a`]);
            expect(notice.value).toContain(`worktree busy`);
        });

        // The rollback withdraws only its own unanswered intent: if two presses are open on one card and the failing
        // one
        // answers last, dropping the successful one's hold would put an archived card back for good.
        it("leaves a card another press did archive off the board when it rolls back", async () => {
            const { archive, lanes } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            const first = held<{ moved: AgentSummary[]; failed: never[]; rev: number }>();
            post.mockReturnValueOnce(first.answer as never);
            const failing = archive([`a`]);
            // The second press, made while the first is still open, is the one that lands.
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], failed: [], rev: 2 } as never);
            await archive([`a`]);

            first.refuse(new Error(`daemon went away`));
            await failing;

            expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
        });
    });

    it("with no ids asks the daemon to clear the lane, and a sweep is the archive that reports", async () => {
        const { archive } = useAgents();
        const { receipt } = useNotifications();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], failed: [], rev: 3 } as never);

        await archive();

        expect(post).toHaveBeenCalledWith(`/agents/archive`, expect.objectContaining({ body: JSON.stringify({}) }));
        expect(receipt.value?.title).toContain(`2 agents archived`);
        expect(receipt.value?.actions?.[0]?.run).toBeTypeOf(`function`);
    });

    it("undo restores exactly what was archived, and reports that it did", async () => {
        const { archive, undoable, lanes, archived } = useAgents();
        const { receipt } = useNotifications();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], failed: [], rev: 4 } as never);
        await archive();

        post.mockResolvedValueOnce({ moved: [agent(`a`), agent(`b`)], failed: [], rev: 5 } as never);
        await receipt.value?.actions?.[0]?.run();

        expect(post).toHaveBeenLastCalledWith(`/agents/unarchive`, expect.objectContaining({ body: JSON.stringify({ ids: [`a`, `b`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        expect(archived.value).toEqual([]);
        expect(receipt.value?.title).toContain(`2`);
        expect(receipt.value?.title).toContain(`board`);
        expect(undoable.value).toEqual([]);
    });

    // Mod+Z reaches the last archive whether or not a receipt was raised, since the single-card case never raises
    // one; without this a quiet archive would be unrecoverable.
    it("undoes a silent single archive from the keyboard", async () => {
        const { archive, undoArchive, undoable, lanes } = useAgents();
        setAgents([agent(`a`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], failed: [], rev: 6 } as never);
        await archive([`a`]);

        post.mockResolvedValueOnce({ moved: [agent(`a`)], failed: [], rev: 7 } as never);
        await undoArchive();

        expect(post).toHaveBeenLastCalledWith(`/agents/unarchive`, expect.objectContaining({ body: JSON.stringify({ ids: [`a`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`a`]);
        expect(undoable.value).toEqual([]);
    });

    // The gate keeping the chord out of everything else Mod+Z means: nothing to put back is not a failed undo, it's
    // not an undo at all.
    it("undoes nothing, and asks the daemon nothing, when there is nothing to put back", async () => {
        const { undoArchive } = useAgents();

        await undoArchive();

        expect(post).not.toHaveBeenCalled();
    });

    // A card restored individually from the archive view leaves the undo set, or undo would try to unarchive an
    // already-restored agent.
    it("drops individually restored agents from the undo set", async () => {
        const { archive, restore, undoable } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], failed: [], rev: 8 } as never);
        await archive();

        post.mockResolvedValueOnce({ moved: [agent(`a`)], failed: [], rev: 9 } as never);
        await restore([`a`]);

        expect(undoable.value).toEqual([`b`]);
    });

    // One agent is a card and a tab, so a bulk archive closes exactly the tabs whose cards moved.
    it("closes the chat tabs of the cards that moved, and only those", async () => {
        const { archive } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`a`), new Conversation(`b`)];
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], failed: [], rev: 11 } as never);

        await archive();

        expect(openTabs()).toEqual([`b`]);
    });

    // A refused press leaves the tab open: closing follows the card leaving, not the press itself.
    it("leaves the chat tab open when the archive failed", async () => {
        const { archive } = useAgents();
        setAgents([agent(`a`)], 1);
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`a`)];
        post.mockRejectedValueOnce(new Error(`the agent's turn is running`));

        await archive([`a`]);

        expect(openTabs()).toEqual([`a`]);
    });

    it("says so plainly when there was nothing to archive, with nothing to undo", async () => {
        const { archive } = useAgents();
        const { receipt } = useNotifications();
        post.mockResolvedValueOnce({ moved: [], failed: [], rev: 10 } as never);

        await archive();

        expect(receipt.value?.title).toContain(`Nothing to archive`);
        expect(receipt.value?.actions).toBeUndefined();
    });

    // A failure must be read, so it lands on the timerless strip, never the self-retiring receipt.
    it("reports a failure on the persistent strip, without dropping any cards off the board", async () => {
        const { archive, notice, lanes } = useAgents();
        const { receipt } = useNotifications();
        setAgents([agent(`a`)], 1);
        post.mockRejectedValueOnce(new Error(`the agent's turn is running`));

        await archive([`a`]);

        expect(notice.value).toContain(`turn is running`);
        expect(receipt.value).toBeUndefined();
        expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`a`]);
    });

    // Clicking card after card makes overlapping archive calls the normal case, not an edge one; each case here pins
    // something that broke when two requests shared state.
    describe("overlapping archives", () => {
        // Resolves on command, so two archives can be held open at once.
        const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
            let resolve!: (value: T) => void;
            const promise = new Promise<T>((settle) => (resolve = settle));
            return { promise, resolve };
        };

        it("keeps each card busy until ITS OWN request lands", async () => {
            const { archive, busyIds } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            const first = deferred<unknown>();
            const second = deferred<unknown>();
            post.mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never);

            const archiveA = archive([`a`]);
            const archiveB = archive([`b`]);
            expect(busyIds.value.toSorted()).toEqual([`a`, `b`]);

            first.resolve({ moved: [archivedAgent(`a`)], failed: [], rev: 7 });
            await archiveA;
            // The bug: one call's cleanup used to clear the shared in-flight list, silencing the other card's request.
            expect(busyIds.value).toEqual([`b`]);

            second.resolve({ moved: [archivedAgent(`b`)], failed: [], rev: 8 });
            await archiveB;
            expect(busyIds.value).toEqual([]);
        });

        it("treats object prototype names as ordinary ids across overlapping claims", async () => {
            const { archive, busyIds } = useAgents();
            setAgents([agent(`__proto__`), agent(`constructor`)], 1);
            const first = deferred<unknown>();
            const second = deferred<unknown>();
            post.mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never);

            const both = archive([`__proto__`, `constructor`]);
            const constructorAgain = archive([`constructor`]);
            expect(busyIds.value.toSorted()).toEqual([`__proto__`, `constructor`]);

            first.resolve({ moved: [], failed: [], rev: 7 });
            await both;
            expect(busyIds.value).toEqual([`constructor`]);

            second.resolve({ moved: [], failed: [], rev: 8 });
            await constructorAgain;
            expect(busyIds.value).toEqual([]);
        });

        it("never lets the slower response put the faster one's card back", async () => {
            const { archive, lanes, archived } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            const first = deferred<unknown>();
            const second = deferred<unknown>();
            post.mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never);

            const archiveA = archive([`a`]);
            const archiveB = archive([`b`]);
            // b finishes first; a's response was composed while b was still on the board.
            second.resolve({ moved: [archivedAgent(`b`)], failed: [], rev: 9 });
            await archiveB;
            first.resolve({ moved: [archivedAgent(`a`)], failed: [], rev: 10 });
            await archiveA;

            expect(lanes.value.finished).toEqual([]);
            expect(archived.value.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        });

        it("merges consecutive archives into one undo that puts all of them back", async () => {
            const { archive, undoArchive, undoable } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], failed: [], rev: 11 } as never);
            await archive([`a`]);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`b`)], failed: [], rev: 12 } as never);
            await archive([`b`]);

            // Clicking down the lane is one intent, so undoing `b` must not drop the way back to `a`.
            expect(undoable.value).toEqual([`b`, `a`]);
            post.mockResolvedValueOnce({ moved: [agent(`a`), agent(`b`)], failed: [], rev: 13 } as never);
            await undoArchive();
            expect(post).toHaveBeenLastCalledWith(`/agents/unarchive`, expect.objectContaining({ body: JSON.stringify({ ids: [`b`, `a`] }) }));
        });

        // The roster arrives as full snapshots from three racing sources, so newest is not "whichever landed last";
        // these
        // pin the ordering rules that replaced that, each one a way an archived card came back.
        it("ignores a roster snapshot older than the one already applied", () => {
            const { lanes } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 5);
            // A slow GET /agents read at revision 3, delivered after the revision-5 frame.
            setAgents([agent(`a`), agent(`b`), agent(`c`)], 3);
            expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        });

        it("keeps an archived card off the board across a NEWER snapshot that predates the archive", async () => {
            const { archive, lanes } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], failed: [], rev: 9 } as never);
            await archive([`a`]);

            // A newer roster can still predate the archive; the pending move holds the card off until revision 9.
            setAgents([agent(`a`), agent(`b`)], 8);
            expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
        });

        it("hands the board back to the daemon once it publishes the archive", async () => {
            const { archive, lanes } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], failed: [], rev: 9 } as never);
            await archive([`a`]);

            // The roster reflecting the archive retires the intent, so a since-restored agent reappears, not stuck.
            setAgents([agent(`a`), agent(`b`)], 9);
            expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        });

        it("forgets the revision line when the stream drops, so a restarted daemon is not rejected", () => {
            const { lanes } = useAgents();
            setAgents([agent(`a`)], 42);
            resetAgents();
            // A restarted daemon counts from 0 again; holding onto 42 would reject every frame it sends.
            setAgents([agent(`a`), agent(`b`)], 0);
            expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        });

        // The undo no longer hangs off the message offering it, letting the message expire on a timer or the
        // single-card
        // case have none at all.
        it("keeps the undo after the receipt that announced it is gone", async () => {
            const { archive, undoable } = useAgents();
            const { receipt, dismissReceipt } = useNotifications();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], failed: [], rev: 14 } as never);
            await archive();

            dismissReceipt();

            expect(receipt.value).toBeUndefined();
            expect(undoable.value).toEqual([`a`, `b`]);
        });
    });
});

// The archive list is pull-only; its one invalidation signal is an id leaving the roster by another hand (daemon
// sweep, another device). Without it the Finished header's count froze at the last visit's reading.
describe("the archive list", () => {
    const agent = (id: string): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        seenAt: 2_000,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    const archivedAgent = (id: string): AgentSummary => ({ ...agent(id), archivedAt: 2_000 });
    const post = vi.mocked(sandboxJson);
    const archivedReads = (): number => post.mock.calls.filter(([path]) => path === `/agents/archived`).length;

    beforeEach(() => {
        post.mockReset().mockResolvedValue({} as never);
        resetAgents();
        resetArchive();
        const other = new Conversation();
        other.isolated.value = false;
        useChat().conversations.value = [other];
    });

    it("re-reads itself when an id leaves the roster by another hand: the daemon's sweep, another device", async () => {
        const { archived } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ agents: [archivedAgent(`b`)] } as never);

        // The retention sweep archived `b`: the next roster frame simply arrives without it.
        setAgents([agent(`a`)], 2);
        await vi.waitFor(() => expect(archived.value.map((entry) => entry.id)).toEqual([`b`]));

        expect(archivedReads()).toBe(1);
    });

    it("stays quiet when the departure is this browser's own archive: both halves are already written", async () => {
        const { archive } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], failed: [], rev: 2 } as never);
        await archive([`a`]);

        // The daemon's own archive account, and a later unrelated frame, are neither news to the list.
        setAgents([agent(`b`)], 2);
        setAgents([agent(`b`)], 3);

        expect(archivedReads()).toBe(0);
    });

    it("stays quiet across a reconnect's first snapshot: a reset board has no ids to depart", () => {
        setAgents([agent(`a`)], 42);
        resetAgents();

        setAgents([agent(`a`)], 0);

        expect(archivedReads()).toBe(0);
    });

    it("is cleared by resetArchive alone: a stream failure must not blank the archive door", async () => {
        const { archived } = useAgents();
        archived.value = [Object.assign(archivedAgent(`a`), { open: false, unread: false, unsent: false })];

        // The liveness loop's failure path: the roster resets, the archive list keeps its last reading.
        resetAgents();
        expect(archived.value.map((entry) => entry.id)).toEqual([`a`]);

        // The sandbox switch: another daemon's archive must not be offered on this board.
        resetArchive();
        expect(archived.value).toEqual([]);
    });
});

// The daemon's own retention sweep used to take only the card and leave the tab, growing the chat list's Finished
// lane unbounded. Same departure signal as the archive list, applied to the strip.
describe("tabs the daemon retired", () => {
    const agent = (id: string): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    const openTabs = (): string[] => useChat().conversations.value.map((conversation) => conversation.conversationId);
    // A tab latched as registered by the roster; an untouched draft would be swept by the tab list's own rules
    // regardless.
    const openAgentTab = (id: string): Conversation => {
        const conversation = new Conversation(id);
        useChat().conversations.value = [...useChat().conversations.value, conversation];
        return conversation;
    };

    beforeEach(() => {
        vi.mocked(sandboxJson)
            .mockReset()
            .mockResolvedValue({} as never);
        resetAgents();
        resetArchive();
        // The user's own chat; focused, so the strip's one-untouched-draft rule keeps it through the writes below.
        useChat().conversations.value = [new Conversation(`here`)];
        useChat().setActive(`here`);
    });

    it("closes the chat of an agent the sweep filed away", () => {
        openAgentTab(`a`);
        setAgents([agent(`a`), agent(`b`)], 1);

        // The retention sweep archived `a`: the next roster frame simply arrives without it.
        setAgents([agent(`b`)], 2);

        expect(openTabs()).toEqual([`here`]);
    });

    // The sweep runs on a clock the user can't see, so it must never empty the panel being read; the tab just marks
    // itself archived and closes once the user moves on.
    it("spares the chat the user is looking at", () => {
        openAgentTab(`a`);
        setAgents([agent(`a`)], 1);
        useChat().setActive(`a`);

        setAgents([], 2);

        expect(openTabs()).toContain(`a`);
    });

    // Everything else a chat holds survives a close (transcript in History, turn detached, branch on the daemon); a
    // half-typed message does not, so it's spared.
    it("spares one holding unsent input", () => {
        const drafted = openAgentTab(`a`);
        openAgentTab(`b`);
        setAgents([agent(`a`), agent(`b`)], 1);
        drafted.draft.value = `and one more thing —`;

        setAgents([], 2);

        expect(openTabs()).toEqual([`here`, `a`]);
    });

    // The departure signal is "left by another hand"; a reconnect resets the board, so its first snapshot has nothing
    // to compare against and must not read as the whole fleet being swept.
    it("keeps every tab across a reconnect's first snapshot", () => {
        openAgentTab(`a`);
        setAgents([agent(`a`)], 7);
        resetAgents();

        setAgents([agent(`a`)], 0);

        expect(openTabs()).toEqual([`here`, `a`]);
    });
});
