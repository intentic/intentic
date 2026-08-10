import { beforeEach, describe, expect, it, vi } from "vitest";

// canArchive is pure, but it lives beside the fleet store, so importing it pulls useChat -> the app shell. Cut
// the edges that need a browser at module-eval, exactly as useChat.test.ts does: the router (createWebHistory wants
// window, and its @intentic/ui barrel drags in .vue files the node test env can't transform), plus the three
// modules that reach environment.ts's window.env read — analytics (direct), useSandbox (via useApi), and
// sandboxClient (via useGoogleIdentity). The projection under test touches none of them.
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { sandboxJson, sandboxRequest } from "../sandbox/sandboxClient";
import { nextTick } from "vue";
import { Conversation } from "../chat/conversation";
import { useChat } from "../chat/useChat";
import { queryClient } from "../queryPersistence";
import { canArchive, FINISHED_WINDOW, type FleetAgent, resetAgents, resetArchive, setAgents, useAgents, windowFinished } from "./useAgents";

/* The Finished lane's cap, and the one card it is never allowed to drop. The board draws a ring on whatever the
 * docked chat is pointing at, so a lane that culls that card leaves the ring nowhere at all — which reads as
 * "this chat is not an agent", not as "that card is further down". */
describe("windowFinished", () => {
    const lane = (count: number): FleetAgent[] =>
        Array.from({ length: count }, (_, at) => ({
            id: `a${at}`,
            status: `landed` as const,
            provider: `claude` as const,
            harness: `native` as const,
            updatedAt: 1_000 - at,
            attention: { plan: false, question: false, permission: false, conflict: false },
            open: false,
            unread: false,
            unsent: false,
        }));
    const ids = (agents: readonly FleetAgent[]): string[] => agents.map((agent) => agent.id);
    // The board reads its entries' own id; the chat list reaches through a wrapper for its conversation's (see
    // ChatTabList). The rule is the same either way, which is why the window takes the reader rather than a type.
    const byId = (agent: FleetAgent): string => agent.id;

    it("shows a short lane whole, with nothing to collapse", () => {
        expect(windowFinished(lane(3), undefined, byId)).toEqual({ shown: lane(3), hidden: 0 });
    });

    it("caps a long lane at the window and counts out the rest", () => {
        const { shown, hidden } = windowFinished(lane(10), undefined, byId);

        expect(shown).toHaveLength(FINISHED_WINDOW);
        expect(hidden).toBe(4);
    });

    it("keeps the selected card whatever its age — pinned at the tail, and counted OUT of the row that hides the rest", () => {
        const { shown, hidden } = windowFinished(lane(10), `a8`, byId);

        expect(ids(shown)).toEqual([`a0`, `a1`, `a2`, `a3`, `a4`, `a5`, `a8`]);
        // Seven cards on screen out of ten: the row below them may only claim the three it actually hides.
        expect(hidden).toBe(3);
    });

    it("leaves the lane alone when the selection is already inside the window — no card is ever shown twice", () => {
        expect(windowFinished(lane(10), `a2`, byId)).toEqual(windowFinished(lane(10), undefined, byId));
    });

    it("leaves it alone for a selection this lane does not hold — an active agent, an archived one, a plain chat", () => {
        expect(windowFinished(lane(10), `nowhere`, byId)).toEqual(windowFinished(lane(10), undefined, byId));
    });

    it("drops the tail row entirely when the pin was the only card behind it", () => {
        const { shown, hidden } = windowFinished(lane(7), `a6`, byId);

        expect(ids(shown)).toEqual([`a0`, `a1`, `a2`, `a3`, `a4`, `a5`, `a6`]);
        expect(hidden).toBe(0);
    });

    // The id the chat list windows by lives one level down, on the conversation the entry wraps — the case the
    // extractor exists for, and the one a `T extends { id }` constraint would have forced a duplicate field for.
    it("windows entries whose id is not their own field — the chat list's wrapped conversations", () => {
        const chats = lane(10).map((agent) => ({ conversation: { conversationId: agent.id } }));
        const { shown, hidden } = windowFinished(chats, `a8`, (entry) => entry.conversation.conversationId);

        expect(shown.map((entry) => entry.conversation.conversationId)).toEqual([`a0`, `a1`, `a2`, `a3`, `a4`, `a5`, `a8`]);
        expect(hidden).toBe(3);
    });
});

/* The board's exit gate, which is NOT the Finished lane. Gating it on the lane is what stranded a failed turn:
 * an errored card's only offered drop is a land onto Finished, so an agent that failed with nothing landable
 * could neither be archived (not finished) nor finish (nothing to land). The line that matters is whether
 * archiving would bury something the agent is still WAITING for. */
describe("canArchive", () => {
    const none = { plan: false, question: false, permission: false, conflict: false };

    it("takes the dead ends — a failed turn and an unlandable conflict are exactly what wants taking off the board", () => {
        expect(canArchive({ status: `error`, attention: none })).toBe(true);
        expect(canArchive({ status: `conflict`, attention: { ...none, conflict: true } })).toBe(true);
        expect(canArchive({ status: `idle`, attention: { ...none, conflict: true } })).toBe(true);
    });

    it("takes the routine case the Finished lane already offered", () => {
        expect(canArchive({ status: `landed`, attention: none })).toBe(true);
        expect(canArchive({ status: `idle`, attention: none })).toBe(true);
    });

    it("refuses an agent waiting to be told something — archiving would bury the question, not answer it", () => {
        expect(canArchive({ status: `awaiting`, attention: none })).toBe(false);
        expect(canArchive({ status: `running`, attention: { ...none, plan: true } })).toBe(false);
        expect(canArchive({ status: `running`, attention: { ...none, question: true } })).toBe(false);
        expect(canArchive({ status: `running`, attention: { ...none, permission: true } })).toBe(false);
    });

    it("refuses a live turn (the worktree is its working state) and a draft (no registry entry to archive)", () => {
        expect(canArchive({ status: `running`, attention: none })).toBe(false);
        expect(canArchive({ status: `draft`, attention: none })).toBe(false);
        // A REFUSED send is the other half of that same reason — it is in the Attention lane, where archiving
        // is otherwise the move, but the daemon turned its request away and so has no entry to file. The
        // affordance the card offers instead is Close (AgentCard.closable).
        expect(canArchive({ status: `failed`, attention: none })).toBe(false);
        // A stopped turn is still a live turn until its generator unwinds — the daemon holds the worktree for
        // the whole of it, and that window is exactly when a user reaches for the next control.
        expect(canArchive({ status: `stopping`, attention: none })).toBe(false);
    });

    // Once it HAS stopped it is a dead end like any other: half-written work, nothing outstanding on the
    // user's side, and archiving buries no question.
    it("takes a turn the user stopped", () => {
        expect(canArchive({ status: `stopped`, attention: none })).toBe(true);
    });

    it("refuses one that is already archived, so the card offers Restore instead of a second Archive", () => {
        expect(canArchive({ status: `landed`, attention: none, archivedAt: 1_000 })).toBe(false);
    });
});

/* An open tab follows the roster's name for its conversation. A tab used to seed its title once and own it,
 * which stopped being enough the moment the daemon could promote a title on its own (a plan heading naming
 * the job) or another device could rename it. */
describe("roster titles", () => {
    const registered = (id: string, title?: string): AgentSummary => ({
        id,
        status: `running`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        attention: { plan: false, question: false, permission: false, conflict: false },
        ...(title !== undefined ? { title } : {}),
    });

    // Each case installs the one tab it is about. The list is never emptied: useChat guarantees an ACTIVE
    // conversation at all times, and its computeds read straight through that guarantee.
    beforeEach(() => {
        resetAgents();
    });

    it("repaints an open tab when the daemon promotes its title", async () => {
        const conversation = new Conversation(`a1`);
        conversation.title.value = `The login page throws on submit`;
        useChat().conversations.value = [conversation];

        setAgents([registered(`a1`, `Fix the login submit handler`)], 1);
        await nextTick();

        expect(conversation.title.value).toBe(`Fix the login submit handler`);
    });

    it("leaves a tab that named itself alone while its entry carries no title", async () => {
        // A draft's first turn has not begun, so the roster knows the conversation without knowing its name —
        // adopting that absence would blank a tab the browser had already titled from the prompt.
        const conversation = new Conversation(`a1`);
        conversation.title.value = `The login page throws on submit`;
        useChat().conversations.value = [conversation];

        setAgents([registered(`a1`)], 1);
        await nextTick();

        expect(conversation.title.value).toBe(`The login page throws on submit`);
    });
});

/* The review panel's diff query is pull-only while the roster is push-fed, so a status transition is the one
 * signal that a land performed elsewhere — the auto-land at turn completion, another device's button — changed
 * what that query holds. Without it the header said "Landed" over a review still counting every file as
 * pending, with Land now armed. */
describe("diff invalidation", () => {
    // seenAt outruns updatedAt so nothing here reads as unread — the markSeen watcher must stay out of a
    // suite that is about cache invalidation, not read markers.
    const summary = (id: string, status: AgentSummary["status"]): AgentSummary => ({
        id,
        status,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        seenAt: 2_000,
        attention: { plan: false, question: false, permission: false, conflict: false },
    });

    beforeEach(() => {
        resetAgents();
    });

    it("invalidates an agent's diff on a status transition — the auto-land flip this browser never performed", () => {
        setAgents([summary(`a1`, `running`)], 1);
        const invalidate = vi.spyOn(queryClient, `invalidateQueries`).mockResolvedValue();

        setAgents([summary(`a1`, `landed`)], 2);

        expect(invalidate).toHaveBeenCalledWith({ queryKey: [`agents`, `a1`, `diff`, `sbx-1`] });
        invalidate.mockRestore();
    });

    it("stays quiet across frames that only tick activity — a running turn must not hammer the diff", () => {
        setAgents([summary(`a1`, `running`)], 1);
        const invalidate = vi.spyOn(queryClient, `invalidateQueries`).mockResolvedValue();

        setAgents([{ ...summary(`a1`, `running`), updatedAt: 2_000 }], 2);

        expect(invalidate).not.toHaveBeenCalled();
        invalidate.mockRestore();
    });

    it("treats an unseen id as a transition — a reconnect's first snapshot may carry a land that happened offline", () => {
        const invalidate = vi.spyOn(queryClient, `invalidateQueries`).mockResolvedValue();

        setAgents([summary(`a1`, `landed`)], 0);

        expect(invalidate).toHaveBeenCalledWith({ queryKey: [`agents`, `a1`, `diff`, `sbx-1`] });
        invalidate.mockRestore();
    });
});

/* The DRAFT card — the fleet's one client-only state, there so "New agent" has a visible result on the board
 * before the first turn registers anything. It used to be derived from "this open tab has no entry on the live
 * roster", which is also true of every agent the user ARCHIVES (the roster carries live agents only) and of
 * every agent at all while the events stream is down. So an archived agent with a tab still open — read from the
 * archive view, or caught by the daemon's retention sweep — came straight back as a brand-new card in the ACTIVE
 * lane. The rule is now a one-way latch on the conversation: a draft is one the fleet has NEVER registered. */
describe("draft cards", () => {
    const registered = (id: string): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        attention: { plan: false, question: false, permission: false, conflict: false },
    });

    // The lane the phantom card landed in, by id — the board's own list, not a count, so a case can say which
    // agent is on it and not merely how many.
    const activeIds = (): string[] => useAgents().lanes.value.active.map((entry) => entry.id);

    beforeEach(() => {
        // These cases drive the real open path, which fires the daemon's best-effort side calls (the read
        // marker, the attach probe). Both are answered rather than left as bare vi.fn()s: an undefined return
        // is not a rejection either function knows how to survive, and the noise would be this file's, not the
        // code's.
        vi.mocked(sandboxJson)
            .mockReset()
            .mockResolvedValue({} as never);
        vi.mocked(sandboxRequest)
            .mockReset()
            .mockResolvedValue({ ok: false } as never);
        resetAgents();
        useAgents().archived.value = [];
        // One open tab per case, installed by the case itself. The list is never emptied — useChat guarantees
        // an active conversation at all times — so this registered placeholder keeps that invariant without
        // posing as another draft under test.
        const other = new Conversation();
        other.isolated.value = false;
        other.registered.value = true;
        useChat().conversations.value = [other];
    });

    it("cards an isolated conversation the fleet has never seen, so New agent lands on the board at once", () => {
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`fresh`)];

        expect(activeIds()).toEqual([`fresh`]);
    });

    it("cards a workspace conversation by the same rule", () => {
        const conversation = new Conversation(`workspace-fresh`);
        conversation.isolated.value = false;
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(activeIds()).toEqual([`workspace-fresh`]);
    });

    /* AN UNREGISTERED CONVERSATION CARRYING AN ERROR IS NOT A DRAFT. The only way one gets here is that its send
     * was REFUSED — the daemon turns a request away and never makes an entry, which is precisely why the fleet
     * has never heard of it. Reading that as a draft put a card nobody can act on into the Active lane, sorted
     * ABOVE the agents genuinely working (drafts lead that lane), where it survived every reload for the life of
     * the sandbox: the report this came from had ten of them.
     *
     * Attention is where it belongs and `Didn't start` is what the chip says, because the card IS a thing that
     * needs the user — and what they do about it is close it, which is the affordance that standing unlocks. */
    it("cards a conversation whose send was refused as failed, in Attention rather than among the working", () => {
        const conversation = new Conversation(`refused`);
        conversation.error.value = `invalid attachment path: nope.png`;
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(activeIds()).toEqual([]);
        expect(useAgents().lanes.value.attention.map((entry) => ({ id: entry.id, status: entry.status }))).toEqual([
            { id: `refused`, status: `failed` },
        ]);
    });

    // The error is about the LAST send, not about the conversation — a turn that goes through clears it, and the
    // card has to follow rather than wear a refusal the user has already sent past.
    it("cards it as a draft again once a turn is under way", () => {
        const conversation = new Conversation(`refused`);
        conversation.error.value = `invalid attachment path: nope.png`;
        useChat().conversations.value = [...useChat().conversations.value, conversation];
        conversation.error.value = null;

        expect(activeIds()).toEqual([`refused`]);
    });

    /* A SENT TURN THE DAEMON HAS NOT FILED YET is `starting`, and the card says what this browser knows about it.
     *
     * It used to report the wire's own `running` and carry the four identity fields alone, so the board drew a
     * title under a spinner and nothing else — no model, no elapsed, no reason — for as long as the wait lasted.
     * That wait is normally a blink and is not always one: turn admission queues behind dependency maintenance,
     * so a message sent during a repair can sit there for minutes looking exactly like a broken card. */
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

    // ...and why it is sitting there, when the daemon has said so. The chat carries the same sentence as a
    // notice; the board is the surface that had no way to say it at all.
    it("says on the card what a queued turn is waiting for", () => {
        const conversation = new Conversation(`sent`);
        conversation.streaming.value = true;
        conversation.waitingFor.value = `dependencies`;
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(useAgents().lanes.value.active.map((card) => card.waitingFor)).toEqual([`dependencies`]);
    });

    /* CLICKING ONE MUST NOT TAKE IT OFF THE BOARD — the reported bug, in one case.
     *
     * `open` latches the tab as registered for a card the fleet DOES know, which is right for every registry card
     * and was being applied to this one too, because `running` was indistinguishable from the daemon's own
     * running. The drafts half then skipped the conversation for being registered and the registry had no entry
     * to render instead, so the agent vanished from every lane on the very click meant to open it — and only a
     * reload brought it back. */
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

    it("stops carding a conversation once the roster registers it — one card, from the registry", () => {
        const conversation = new Conversation(`a1`);
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        setAgents([registered(`a1`)], 1);

        expect(conversation.registered.value).toBe(true);
        expect(activeIds()).toEqual([]);
        expect(useAgents().lanes.value.finished.map((entry) => entry.id)).toEqual([`a1`]);
    });

    // Archive from the board while the agent's chat is open in the dock: the card leaves BOTH views, and the tab
    // it closes must not come back as a phantom draft in the Active lane (the reported bug).
    it("takes the chat tab with the card, leaving nothing behind in either view", async () => {
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`a1`)];
        setAgents([registered(`a1`)], 1);
        vi.mocked(sandboxJson).mockResolvedValueOnce({ moved: [{ ...registered(`a1`), archivedAt: 2_000 }], rev: 2 } as never);

        await useAgents().archive([`a1`]);

        expect(useChat().conversations.value.some((conversation) => conversation.conversationId === `a1`)).toBe(false);
        expect(activeIds()).toEqual([]);
        expect(useAgents().lanes.value.finished).toEqual([]);
        expect(useAgents().archived.value.map((entry) => entry.id)).toEqual([`a1`]);
    });

    // The same hole, reached from the other side: an archived agent keeps its branch, its diff and its
    // transcript, so reading one from the archive is a real destination — and it OPENS the tab, which must not
    // put the card the user just filed away straight back on the board.
    it("leaves it off the board when its tab is opened from the archive", () => {
        const { archived, open } = useAgents();
        const entry = { ...registered(`a1`), archivedAt: 2_000 };
        archived.value = [{ ...entry, open: false, unread: false, unsent: false }];

        open(entry);

        expect(activeIds()).toEqual([]);
        expect(useChat().conversations.value.some((conversation) => conversation.conversationId === `a1`)).toBe(true);
    });

    // A dropped events stream empties the roster wholesale. Reading that as "every open agent is a draft" put
    // the whole fleet into the Active lane as fresh cards until the reconnect's first frame repainted it.
    it("does not turn every open agent tab into a draft when the stream drops", () => {
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`a1`)];
        setAgents([registered(`a1`)], 1);

        resetAgents();

        expect(activeIds()).toEqual([]);
    });

    /* A CONVERSATION REOPENED FROM HISTORY IS NOT A DRAFT. It has no registry entry — the agent that ran it is
     * long gone, or it was a plain chat — so it lands in this same client-only half, and calling that a draft
     * put a three-week-old conversation at the HEAD of the Active lane wearing "Draft": the board announcing
     * the user's own history as work about to begin. Nothing is running and nothing is owed, which is
     * `finished`. */
    it("cards a conversation reopened from History as an earlier chat, not as a fresh draft", () => {
        const conversation = new Conversation(`old-chat`);
        conversation.session.value = { id: `sess-1`, provider: `claude`, account: undefined, harness: `native` };
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        expect(activeIds()).toEqual([]);
        expect(useAgents().lanes.value.finished.map((entry) => ({ id: entry.id, status: entry.status }))).toEqual([
            { id: `old-chat`, status: `resumed` },
        ]);
    });

    /* WORDS THE USER HAS NOT SENT KEEP AN ARCHIVED SESSION ON THE BOARD.
     *
     * Reading an agent out of the archive opens its chat by design, and typing there is the ordinary next move.
     * The board had no card for it, so clearing the search that found it left the half-written message with
     * nowhere to be seen from — the report this came from. It is lifted for exactly as long as the words are
     * there, says "archived" on its face (archivedAt survives the lift), and nothing is written daemon-side. */
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

    // ...and it files itself straight back when they go. Whitespace is not a message — send() refuses it too, so
    // a stray space must not be what keeps a card on the board for the rest of the day.
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

/* THE FOLD, AND WHAT IT MAY NOT SWALLOW. The Finished lane windows to FINISHED_WINDOW cards while it is being
 * browsed, ordered by recency — so an old session is behind the fold by definition, which is fine right up
 * until the user starts writing in one. Those words live in this window and nowhere else, so the ordering puts
 * them in front of the fold and the only thing that can push one behind it is MORE unsent messages than the
 * window has room for: at that point they are hiding each other rather than being hidden by unrelated work. */
describe("the finished fold", () => {
    const landed = (id: string, updatedAt: number): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt,
        attention: { plan: false, question: false, permission: false, conflict: false },
    });
    const shownIds = (): string[] => windowFinished(useAgents().lanes.value.finished, undefined, (entry) => entry.id).shown.map((entry) => entry.id);

    beforeEach(() => {
        resetAgents();
        useAgents().archived.value = [];
        const other = new Conversation();
        other.registered.value = true;
        useChat().conversations.value = [other];
    });

    // The reported case, at the store level: the session the user searched up is the oldest thing in the lane,
    // so the fold has it — until they start writing, at which point it leads the lane instead.
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

    // Ordering, not pinning: the cards holding words lead the lane (newest of them first, the lane's own rule),
    // and the window then falls where it falls. Past a window's worth of them the fold is back, which is the
    // honest outcome — the lane is a browsing list, not a promise to draw everything at once.
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
});

/* CARDS THAT WOULD NOT SIT STILL — the reported bug, and the argument for the tiebreaker every lane order now
 * ends on.
 *
 * A tie in a sort is not a draw, it is a question passed down: the order falls to the array underneath, and
 * this board's array is `fleet`, kept sorted by `updatedAt` descending. That clock ticks per agent, a second
 * at a time and out of step with the rest, so every activity frame dealt the tied cards a fresh order and the
 * column reshuffled itself under the user's eyes.
 *
 * The ties are ordinary. Agents resumed TOGETHER — one credential renewal bringing a batch of turns back —
 * begin in the same millisecond, so they carry an identical `startedAt` for as long as they run. */
describe("lane order holds still", () => {
    const running = (id: string, startedAt: number, updatedAt: number): AgentSummary => ({
        id,
        status: `running`,
        provider: `claude`,
        harness: `native`,
        startedAt,
        updatedAt,
        attention: { plan: false, question: false, permission: false, conflict: false },
    });
    const activeIds = (): string[] => useAgents().lanes.value.active.map((entry) => entry.id);

    beforeEach(() => {
        resetAgents();
        useAgents().archived.value = [];
        const other = new Conversation();
        other.registered.value = true;
        useChat().conversations.value = [other];
    });

    // The report itself: four agents resumed at one stroke, each reporting its own activity, trading places in
    // the column every second. The lane settles on one order and every frame after it is the SAME order.
    it("holds agents that started in the same millisecond in place as their activity ticks", () => {
        const batch = [`c`, `a`, `d`, `b`];
        setAgents(
            batch.map((id) => running(id, 5_000, 5_000)),
            1,
        );
        const settled = activeIds();

        expect(settled).toHaveLength(4);
        // Each in turn becomes the most recently active — the frames that used to re-deal the lane.
        for (const [at, live] of batch.entries()) {
            setAgents(
                batch.map((id) => running(id, 5_000, id === live ? 6_000 + at : 5_000)),
                at + 2,
            );

            expect(activeIds()).toEqual(settled);
        }
    });

    // Attention orders on `updatedAt` alone, so a batch that also stalls together (two agents asking at once)
    // ties outright — the same churn, one lane over.
    it("holds the attention lane still when two cards share an updatedAt", () => {
        const asking = (id: string): AgentSummary => ({
            ...running(id, 5_000, 7_000),
            status: `awaiting`,
            attention: { plan: false, question: true, permission: false, conflict: false },
        });
        setAgents([asking(`b`), asking(`a`)], 1);
        const settled = useAgents().lanes.value.attention.map((entry) => entry.id);

        // The daemon's own roster order is not a promise — the same agents arrive the other way round on the
        // next frame, and the lane may not move because of it.
        setAgents([asking(`a`), asking(`b`)], 2);

        expect(useAgents().lanes.value.attention.map((entry) => entry.id)).toEqual(settled);
    });
});

// The board's exit. Archiving is the ROUTINE way an agent leaves the fleet, so what these pin down is the
// thing that makes it routine: it never asks first, it never interrupts, and it always keeps a way back.
describe("archive", () => {
    const agent = (id: string): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        attention: { plan: false, question: false, permission: false, conflict: false },
    });
    const archivedAgent = (id: string): AgentSummary => ({ ...agent(id), archivedAt: 2_000 });
    const post = vi.mocked(sandboxJson);
    // The tabs whose conversation is one of THIS suite's agents — the strip also carries the main-tree chat the
    // reset installs, which no archive is about.
    const openTabs = (): string[] =>
        useChat()
            .conversations.value.map((conversation) => conversation.conversationId)
            .filter((id) => [`a`, `b`].includes(id));

    // The store is a module singleton (one board per app), so each case resets what it looks at — resetAgents
    // drops the roster, the undo set and both reports, since all of them were promises about one daemon. The
    // tab strip is reset too, since archiving now writes to it: one MAIN-TREE chat, which is not fleet work and
    // cards nothing, so a case that wants an agent's tab open installs it itself.
    beforeEach(() => {
        // Answered by default rather than left bare: an archive fires the daemon's best-effort side calls (the
        // read marker), and an undefined return is not something they know how to survive. The per-case
        // mockResolvedValueOnce/mockRejectedValueOnce still take precedence.
        post.mockReset().mockResolvedValue({} as never);
        resetAgents();
        useAgents().archived.value = [];
        const other = new Conversation();
        other.isolated.value = false;
        useChat().conversations.value = [other];
    });

    it("moves what the daemon says moved, and keeps a way back without saying a word", async () => {
        const { archive, notice, receipt, undoable, archivedFlash, lanes, archived } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        const flashes = archivedFlash.value;
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 2 } as never);

        await archive([`a`]);

        expect(post).toHaveBeenCalledWith(`/agents/archive`, expect.objectContaining({ method: `POST`, body: JSON.stringify({ ids: [`a`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
        // The archive half is filled from the same response — no second round-trip, so the detail page's
        // cross-half lookup resolves an agent archived under the user's cursor.
        expect(archived.value.map((entry) => entry.id)).toEqual([`a`]);
        // The whole point of the rework: one card is the routine case, and the routine case interrupts nobody.
        expect(receipt.value).toBeUndefined();
        expect(notice.value).toBeUndefined();
        // Quiet is not the same as unrecoverable — the undo is held, and the counter is told to pulse.
        expect(undoable.value).toEqual([`a`]);
        expect(archivedFlash.value).toBe(flashes + 1);
    });

    it("with no ids asks the daemon to clear the lane, and a sweep is the archive that reports", async () => {
        const { archive, receipt } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], rev: 3 } as never);

        await archive();

        expect(post).toHaveBeenCalledWith(`/agents/archive`, expect.objectContaining({ body: JSON.stringify({}) }));
        expect(receipt.value?.message).toContain(`2 agents archived`);
        expect(receipt.value?.undo).toBeTypeOf(`function`);
    });

    it("undo restores exactly what was archived, and takes the receipt with it", async () => {
        const { archive, receipt, undoable, lanes, archived } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], rev: 4 } as never);
        await archive();

        post.mockResolvedValueOnce({ moved: [agent(`a`), agent(`b`)], rev: 5 } as never);
        await receipt.value?.undo?.();

        expect(post).toHaveBeenLastCalledWith(`/agents/unarchive`, expect.objectContaining({ body: JSON.stringify({ ids: [`a`, `b`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        expect(archived.value).toEqual([]);
        expect(receipt.value).toBeUndefined();
        expect(undoable.value).toEqual([]);
    });

    // Mod+Z reaches the last archive whether or not a receipt was ever raised — which, for the single-card
    // case, it never is. Without this the quiet archive would be the unrecoverable one.
    it("undoes a silent single archive from the keyboard", async () => {
        const { archive, undoArchive, undoable, lanes } = useAgents();
        setAgents([agent(`a`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 6 } as never);
        await archive([`a`]);

        post.mockResolvedValueOnce({ moved: [agent(`a`)], rev: 7 } as never);
        await undoArchive();

        expect(post).toHaveBeenLastCalledWith(`/agents/unarchive`, expect.objectContaining({ body: JSON.stringify({ ids: [`a`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`a`]);
        expect(undoable.value).toEqual([]);
    });

    // The gate that lets the chord stay out of everything else Mod+Z means: with nothing to put back it is
    // not an undo that fails, it is not an undo at all.
    it("undoes nothing, and asks the daemon nothing, when there is nothing to put back", async () => {
        const { undoArchive } = useAgents();

        await undoArchive();

        expect(post).not.toHaveBeenCalled();
    });

    // A card restored one at a time from the archive view is no longer the undo's to give back, or the undo
    // would ask the daemon to unarchive an agent that is already on the board.
    it("drops individually restored agents from the undo set", async () => {
        const { archive, restore, undoable } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], rev: 8 } as never);
        await archive();

        post.mockResolvedValueOnce({ moved: [agent(`a`)], rev: 9 } as never);
        await restore([`a`]);

        expect(undoable.value).toEqual([`b`]);
    });

    // One agent is a card and a tab, so the archive moves both — driven off `moved`, so a bulk sweep closes
    // exactly the chats whose cards left and no others.
    it("closes the chat tabs of the cards that moved, and only those", async () => {
        const { archive } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`a`), new Conversation(`b`)];
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 11 } as never);

        await archive();

        expect(openTabs()).toEqual([`b`]);
    });

    // A press the daemon refused leaves the tab where it was: the close is a consequence of the card leaving the
    // board, not of the button being pressed.
    it("leaves the chat tab open when the archive failed", async () => {
        const { archive } = useAgents();
        setAgents([agent(`a`)], 1);
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`a`)];
        post.mockRejectedValueOnce(new Error(`the agent's turn is running`));

        await archive([`a`]);

        expect(openTabs()).toEqual([`a`]);
    });

    it("says so plainly when there was nothing to archive, with nothing to undo", async () => {
        const { archive, receipt } = useAgents();
        post.mockResolvedValueOnce({ moved: [], rev: 10 } as never);

        await archive();

        expect(receipt.value?.message).toContain(`Nothing to archive`);
        expect(receipt.value?.undo).toBeUndefined();
    });

    // A failure is the one thing here that must be read, so it lands on the strip that has no timer — never
    // on the receipt, which retires itself whether or not anyone looked.
    it("reports a failure on the persistent strip, without dropping any cards off the board", async () => {
        const { archive, notice, receipt, lanes } = useAgents();
        setAgents([agent(`a`)], 1);
        post.mockRejectedValueOnce(new Error(`the agent's turn is running`));

        await archive([`a`]);

        expect(notice.value).toContain(`turn is running`);
        expect(receipt.value).toBeUndefined();
        expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`a`]);
    });

    // Clicking card after card is the normal way this gets used, so overlapping calls are the normal case —
    // not an edge one. Each of these pins something that broke when the two requests shared one piece of state.
    describe("overlapping archives", () => {
        // Resolves when the test says so, so two archives can be held open at once.
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

            first.resolve({ moved: [archivedAgent(`a`)], rev: 7 });
            await archiveA;
            // The bug: the first call's cleanup used to clear the shared in-flight list, so b's card went quiet
            // while its request was still open.
            expect(busyIds.value).toEqual([`b`]);

            second.resolve({ moved: [archivedAgent(`b`)], rev: 8 });
            await archiveB;
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
            // b finishes first; a's response was composed when b was still on the board.
            second.resolve({ moved: [archivedAgent(`b`)], rev: 9 });
            await archiveB;
            first.resolve({ moved: [archivedAgent(`a`)], rev: 10 });
            await archiveA;

            expect(lanes.value.finished).toEqual([]);
            expect(archived.value.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        });

        it("merges consecutive archives into one undo that puts all of them back", async () => {
            const { archive, undoArchive, undoable } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 11 } as never);
            await archive([`a`]);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`b`)], rev: 12 } as never);
            await archive([`b`]);

            // Clicking down the lane is ONE intent, so the way back to `a` is not dropped by archiving `b`.
            expect(undoable.value).toEqual([`b`, `a`]);
            post.mockResolvedValueOnce({ moved: [agent(`a`), agent(`b`)], rev: 13 } as never);
            await undoArchive();
            expect(post).toHaveBeenLastCalledWith(`/agents/unarchive`, expect.objectContaining({ body: JSON.stringify({ ids: [`b`, `a`] }) }));
        });

        // The roster arrives as full snapshots from three racing sources (the /events stream, refresh(), and
        // this browser's own writes), so "which one is newest" cannot be "which one landed last". These pin the
        // ordering rules that replaced last-frame-wins — each was a way an archived card came back.
        it("ignores a roster snapshot older than the one already applied", () => {
            const { lanes } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 5);
            // A slow GET /agents that was read at revision 3 and delivered after the revision-5 frame.
            setAgents([agent(`a`), agent(`b`), agent(`c`)], 3);
            expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        });

        it("keeps an archived card off the board across a NEWER snapshot that predates the archive", async () => {
            const { archive, lanes } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 9 } as never);
            await archive([`a`]);

            // A running turn ticks updatedAt about once a second, so a legitimately newer roster arrives that
            // was still composed before the archive applied. Revision ordering alone would accept it and put
            // the card back; the pending move is what holds the board steady until revision 9.
            setAgents([agent(`a`), agent(`b`)], 8);
            expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
        });

        it("hands the board back to the daemon once it publishes the archive", async () => {
            const { archive, lanes } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 9 } as never);
            await archive([`a`]);

            // The roster that reflects the archive retires the local intent — and the daemon is authoritative
            // again, so an agent it has since restored elsewhere reappears instead of being held off forever.
            setAgents([agent(`a`), agent(`b`)], 9);
            expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        });

        it("forgets the revision line when the stream drops, so a restarted daemon is not rejected", () => {
            const { lanes } = useAgents();
            setAgents([agent(`a`)], 42);
            resetAgents();
            // A daemon that restarted counts from 0 again; holding onto 42 would reject every frame it sends.
            setAgents([agent(`a`), agent(`b`)], 0);
            expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        });

        // The way back no longer hangs off the message offering it — which is what lets the message expire on
        // a timer, and lets the single-card archive have no message at all.
        it("keeps the undo after the receipt that announced it is gone", async () => {
            const { archive, receipt, dismissReceipt, undoable } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], rev: 14 } as never);
            await archive();

            dismissReceipt();

            expect(receipt.value).toBeUndefined();
            expect(undoable.value).toEqual([`a`, `b`]);
        });
    });
});

/* The archive list is the fleet's pull-only half — no stream carries it — so its one invalidation signal is an
 * id leaving the roster by another hand than this browser's (the daemon's retention sweep, another device's
 * archive or discard). Without it the Finished header's count, and the archive door it gates, froze at
 * whatever the last visit read — which is how the door came to look like it disappears. */
describe("the archive list", () => {
    const agent = (id: string): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        seenAt: 2_000,
        attention: { plan: false, question: false, permission: false, conflict: false },
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

    it("re-reads itself when an id leaves the roster by another hand — the daemon's sweep, another device", async () => {
        const { archived } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ agents: [archivedAgent(`b`)] } as never);

        // The retention sweep archived `b`: the next roster frame simply arrives without it.
        setAgents([agent(`a`)], 2);
        await vi.waitFor(() => expect(archived.value.map((entry) => entry.id)).toEqual([`b`]));

        expect(archivedReads()).toBe(1);
    });

    it("stays quiet when the departure is this browser's own archive — both halves are already written", async () => {
        const { archive } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 2 } as never);
        await archive([`a`]);

        // The daemon's own account of the archive, and a later unrelated frame — neither is news to the list.
        setAgents([agent(`b`)], 2);
        setAgents([agent(`b`)], 3);

        expect(archivedReads()).toBe(0);
    });

    it("stays quiet across a reconnect's first snapshot — a reset board has no ids to depart", () => {
        setAgents([agent(`a`)], 42);
        resetAgents();

        setAgents([agent(`a`)], 0);

        expect(archivedReads()).toBe(0);
    });

    it("is cleared by resetArchive alone — a stream failure must not blank the archive door", async () => {
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

/* THE SWEEP'S OTHER HALF. One agent is a card and a tab, and the two only ever moved together when the press
 * happened in this browser: archiving from the board closed the chat with the card, while the daemon's own
 * retention sweep took the card and left the tab. So the board stayed six deep while the chat list's Finished
 * lane grew for the life of the sandbox — the thing the user reports as "my popped-out chat never cleans up".
 * Same departure signal as the archive list above, applied to the strip. */
describe("tabs the daemon retired", () => {
    const agent = (id: string): AgentSummary => ({
        id,
        status: `landed`,
        provider: `claude`,
        harness: `native`,
        updatedAt: 1_000,
        attention: { plan: false, question: false, permission: false, conflict: false },
    });
    const openTabs = (): string[] => useChat().conversations.value.map((conversation) => conversation.conversationId);
    // A tab the roster has latched as registered — an untouched draft would be swept by the tab list's own
    // rules, and would prove nothing about this one.
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
        // The chat the user is sitting in, which is not fleet work and cards nothing. Focused, so the strip's
        // "at most one untouched draft, and only the focused one" rule keeps it through every write below.
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

    // The sweep runs on a clock the user cannot see, so the one thing it must never do is empty the panel that
    // is being read. The tab says it is archived and closes like any other once the user moves on.
    it("spares the chat the user is looking at", () => {
        openAgentTab(`a`);
        setAgents([agent(`a`)], 1);
        useChat().setActive(`a`);

        setAgents([], 2);

        expect(openTabs()).toContain(`a`);
    });

    // Everything else a chat holds survives a close — the transcript is in History, the turn detaches, the
    // branch is on the daemon. A half-typed message does not.
    it("spares one holding unsent input", () => {
        const drafted = openAgentTab(`a`);
        openAgentTab(`b`);
        setAgents([agent(`a`), agent(`b`)], 1);
        drafted.draft.value = `and one more thing —`;

        setAgents([], 2);

        expect(openTabs()).toEqual([`here`, `a`]);
    });

    // The departure signal is "left by another hand". A reconnect resets the board, so its first snapshot has
    // nothing to compare against — and must not read as the whole fleet being swept.
    it("keeps every tab across a reconnect's first snapshot", () => {
        openAgentTab(`a`);
        setAgents([agent(`a`)], 7);
        resetAgents();

        setAgents([agent(`a`)], 0);

        expect(openTabs()).toEqual([`here`, `a`]);
    });
});
