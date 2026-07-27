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
    return { useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }) };
});
vi.mock("../sandbox/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { sandboxJson } from "../sandbox/sandboxClient";
import { laneOf, resetAgents, setAgents, useAgents } from "./useAgents";

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

// The board's exit. Archiving is the ROUTINE way an agent leaves the fleet, so what these pin down is the
// thing that makes it routine: it never asks first, and it always offers the way back.
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

    // The store is a module singleton (one board per app), so each case resets what it looks at.
    beforeEach(() => {
        post.mockReset();
        resetAgents();
        const { dismissNotice, archived } = useAgents();
        archived.value = [];
        dismissNotice();
    });

    it("moves what the daemon says moved, and offers an undo built from it", async () => {
        const { archive, notice, lanes, archived } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 2 } as never);

        await archive([`a`]);

        expect(post).toHaveBeenCalledWith(`/agents/archive`, expect.objectContaining({ method: `POST`, body: JSON.stringify({ ids: [`a`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
        // The archive half is filled from the same response — no second round-trip, so the detail page's
        // cross-half lookup resolves an agent archived under the user's cursor.
        expect(archived.value.map((entry) => entry.id)).toEqual([`a`]);
        expect(notice.value?.tone).toBe(`info`);
        expect(notice.value?.message).toContain(`1 agent archived`);
        expect(notice.value?.undo).toBeTypeOf(`function`);
    });

    it("with no ids asks the daemon to clear the lane, and pluralizes what it took", async () => {
        const { archive, notice } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], rev: 3 } as never);

        await archive();

        expect(post).toHaveBeenCalledWith(`/agents/archive`, expect.objectContaining({ body: JSON.stringify({}) }));
        expect(notice.value?.message).toContain(`2 agents archived`);
    });

    it("undo restores exactly what was archived, and clears the notice", async () => {
        const { archive, notice, lanes, archived } = useAgents();
        setAgents([agent(`a`), agent(`b`)], 1);
        post.mockResolvedValueOnce({ moved: [archivedAgent(`a`), archivedAgent(`b`)], rev: 4 } as never);
        await archive();

        post.mockResolvedValueOnce({ moved: [agent(`a`), agent(`b`)], rev: 5 } as never);
        await notice.value?.undo?.();

        expect(post).toHaveBeenLastCalledWith(`/agents/unarchive`, expect.objectContaining({ body: JSON.stringify({ ids: [`a`, `b`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        expect(archived.value).toEqual([]);
        expect(notice.value).toBeUndefined();
    });

    it("says so plainly when there was nothing to archive, with nothing to undo", async () => {
        const { archive, notice } = useAgents();
        post.mockResolvedValueOnce({ moved: [], rev: 6 } as never);

        await archive();

        expect(notice.value?.tone).toBe(`info`);
        expect(notice.value?.undo).toBeUndefined();
    });

    it("reports a failure without dropping any cards off the board", async () => {
        const { archive, notice, lanes } = useAgents();
        setAgents([agent(`a`)], 1);
        post.mockRejectedValueOnce(new Error(`the agent's turn is running`));

        await archive([`a`]);

        expect(notice.value?.tone).toBe(`error`);
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
            const { archive, notice } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 11 } as never);
            await archive([`a`]);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`b`)], rev: 12 } as never);
            await archive([`b`]);

            // Not "1 agent archived" with the way back to `a` silently dropped.
            expect(notice.value?.message).toContain(`2 agents archived`);
            post.mockResolvedValueOnce({ moved: [agent(`a`), agent(`b`)], rev: 13 } as never);
            await notice.value?.undo?.();
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

        it("drops the merged undo once its notice is gone", async () => {
            const { archive, notice, dismissNotice } = useAgents();
            setAgents([agent(`a`), agent(`b`)], 1);
            post.mockResolvedValueOnce({ moved: [archivedAgent(`a`)], rev: 14 } as never);
            await archive([`a`]);
            dismissNotice();

            post.mockResolvedValueOnce({ moved: [archivedAgent(`b`)], rev: 15 } as never);
            await archive([`b`]);
            // `a` was acknowledged and is off the strip — the new receipt speaks only for `b`.
            expect(notice.value?.message).toContain(`1 agent archived`);
            expect(notice.value?.restores).toEqual([`b`]);
        });
    });
});
