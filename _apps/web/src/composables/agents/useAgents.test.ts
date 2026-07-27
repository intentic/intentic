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
import { laneOf, setAgents, useAgents } from "./useAgents";

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
    const post = vi.mocked(sandboxJson);

    // The store is a module singleton (one board per app), so each case resets what it looks at.
    beforeEach(() => {
        post.mockReset();
        setAgents([]);
        const { dismissNotice, archived } = useAgents();
        archived.value = [];
        dismissNotice();
    });

    it("takes the roster the daemon answers with, and offers an undo built from what moved", async () => {
        const { archive, notice, lanes } = useAgents();
        setAgents([agent(`a`), agent(`b`)]);
        post.mockResolvedValueOnce({ agents: [agent(`b`)], archived: [`a`] } as never);

        await archive([`a`]);

        expect(post).toHaveBeenCalledWith(`/agents/archive`, expect.objectContaining({ method: `POST`, body: JSON.stringify({ ids: [`a`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`b`]);
        expect(notice.value?.tone).toBe(`info`);
        expect(notice.value?.message).toContain(`1 agent archived`);
        expect(notice.value?.undo).toBeTypeOf(`function`);
    });

    it("with no ids asks the daemon to clear the lane, and pluralizes what it took", async () => {
        const { archive, notice } = useAgents();
        setAgents([agent(`a`), agent(`b`)]);
        post.mockResolvedValueOnce({ agents: [], archived: [`a`, `b`] } as never);

        await archive();

        expect(post).toHaveBeenCalledWith(`/agents/archive`, expect.objectContaining({ body: JSON.stringify({}) }));
        expect(notice.value?.message).toContain(`2 agents archived`);
    });

    it("undo restores exactly what was archived, and clears the notice", async () => {
        const { archive, notice, lanes } = useAgents();
        setAgents([agent(`a`), agent(`b`)]);
        post.mockResolvedValueOnce({ agents: [], archived: [`a`, `b`] } as never);
        await archive();

        post.mockResolvedValueOnce({ agents: [agent(`a`), agent(`b`)] } as never);
        await notice.value?.undo?.();

        expect(post).toHaveBeenLastCalledWith(`/agents/unarchive`, expect.objectContaining({ body: JSON.stringify({ ids: [`a`, `b`] }) }));
        expect(lanes.value.finished.map((entry) => entry.id).toSorted()).toEqual([`a`, `b`]);
        expect(notice.value).toBeUndefined();
    });

    it("says so plainly when there was nothing to archive, with nothing to undo", async () => {
        const { archive, notice } = useAgents();
        post.mockResolvedValueOnce({ agents: [], archived: [] } as never);

        await archive();

        expect(notice.value?.tone).toBe(`info`);
        expect(notice.value?.undo).toBeUndefined();
    });

    it("reports a failure without dropping any cards off the board", async () => {
        const { archive, notice, lanes } = useAgents();
        setAgents([agent(`a`)]);
        post.mockRejectedValueOnce(new Error(`the agent's turn is running`));

        await archive([`a`]);

        expect(notice.value?.tone).toBe(`error`);
        expect(lanes.value.finished.map((entry) => entry.id)).toEqual([`a`]);
    });
});
