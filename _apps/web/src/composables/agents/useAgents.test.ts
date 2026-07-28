import { beforeEach, describe, expect, it, vi } from "vitest";

// laneOf is pure, but it lives beside the fleet store, so importing it pulls useChat -> the app shell. Cut the
// edges that need a browser at module-eval, exactly as useChat.test.ts does: the router (createWebHistory wants
// window, and its @intentic-app/ui barrel drags in .vue files the node test env can't transform), plus the three
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
import { canArchive, laneOf, resetAgents, setAgents, useAgents } from "./useAgents";

// The kanban lane projection — pure over status + attention, so "finished" needs no explicit action:
// a cleanly-completed, auto-landed turn reads landed/idle and the card moves lanes on the next roster frame.
describe("laneOf", () => {
    const none = { plan: false, question: false, permission: false, conflict: false };

    it("routes pending plan/question/conflict and errors to attention", () => {
        expect(laneOf({ status: `running`, attention: { ...none, plan: true } })).toBe(`attention`);
        expect(laneOf({ status: `running`, attention: { ...none, question: true } })).toBe(`attention`);
        expect(laneOf({ status: `conflict`, attention: { ...none, conflict: true } })).toBe(`attention`);
        expect(laneOf({ status: `awaiting`, attention: none })).toBe(`attention`);
        expect(laneOf({ status: `error`, attention: none })).toBe(`attention`);
    });

    it("routes running turns and fresh drafts to active", () => {
        expect(laneOf({ status: `running`, attention: none })).toBe(`active`);
        expect(laneOf({ status: `draft`, attention: none })).toBe(`active`);
    });

    it("routes landed and idle agents to finished — the auto-finish rule", () => {
        expect(laneOf({ status: `landed`, attention: none })).toBe(`finished`);
        expect(laneOf({ status: `idle`, attention: none })).toBe(`finished`);
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
 * every agent at all while the events stream is down. So an archived agent whose chat tab stayed open — the
 * normal case, since the tab is how you were reading it — came straight back as a brand-new card in the ACTIVE
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
        // an active conversation at all times — so it starts on a MAIN-TREE chat, which is not fleet work at
        // all and cards nothing either way.
        const other = new Conversation();
        other.isolated.value = false;
        useChat().conversations.value = [other];
    });

    it("cards an isolated conversation the fleet has never seen, so New agent lands on the board at once", () => {
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`fresh`)];

        expect(activeIds()).toEqual([`fresh`]);
    });

    it("stops carding a conversation once the roster registers it — one card, from the registry", () => {
        const conversation = new Conversation(`a1`);
        useChat().conversations.value = [...useChat().conversations.value, conversation];

        setAgents([registered(`a1`)], 1);

        expect(conversation.registered.value).toBe(true);
        expect(activeIds()).toEqual([]);
        expect(useAgents().lanes.value.finished.map((entry) => entry.id)).toEqual([`a1`]);
    });

    // The reported bug, end to end: archive from the board while the agent's chat is open in the dock.
    it("leaves an archived agent off the board while its chat tab stays open", async () => {
        useChat().conversations.value = [...useChat().conversations.value, new Conversation(`a1`)];
        setAgents([registered(`a1`)], 1);
        vi.mocked(sandboxJson).mockResolvedValueOnce({ moved: [{ ...registered(`a1`), archivedAt: 2_000 }], rev: 2 } as never);

        await useAgents().archive([`a1`]);

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
        archived.value = [{ ...entry, open: false, unread: false }];

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

    // The store is a module singleton (one board per app), so each case resets what it looks at — resetAgents
    // drops the roster, the undo set and both reports, since all of them were promises about one daemon.
    beforeEach(() => {
        post.mockReset();
        resetAgents();
        useAgents().archived.value = [];
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
