import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { AgentSummary } from "@intentic/sandbox-contract";

// Exercises the pure derivation only, not the store's polling: a failed read must never become a zero, since this
// number ends up on both the switcher row and the rail badge, and disagreeing between them is the failure to avoid.

// Mocks the query client and sandbox client, neither of which the derivation under test touches.
const sandboxes = ref<{ id: string; name: string; lastSeenAt: string | null }[]>([]);
const activeSandboxId = ref<string | undefined>(`sbx-here`);
vi.mock("../client/useSandbox", () => ({ useSandbox: () => ({ sandboxes, activeSandboxId }) }));
const sandboxJsonQuietly = vi.fn();
vi.mock("../client/sandboxClient", () => ({ sandboxJsonQuietly }));
vi.mock("../../../lib/queryPersistence", () => ({ queryClient: { setQueryData: vi.fn() } }));

const { boxAttention, markSeenAcross, otherBoxes, subscribe } = await import("./fleetAcross");
type BoxFleet = Parameters<typeof boxAttention>[0];

const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const agent = (over: Partial<AgentSummary>): AgentSummary =>
    ({ id: `a1`, status: `idle`, provider: `claude`, harness: `claude-code`, updatedAt: 1, attention: none, ...over }) as AgentSummary;

const box = (over: Partial<BoxFleet>): BoxFleet =>
    ({ sandbox: { id: `sbx-other`, name: `Laptop` }, state: `ready`, agents: [], held: [], readAt: 1000, ...over }) as BoxFleet;

describe("what one other box is holding for its owner", () => {
    // Rendering a never-answered box as `0` would falsely claim nothing's waiting; surfaces draw a dash instead.
    it("has no answer at all for a box that has never been read", () => {
        expect(boxAttention(box({ readAt: undefined, state: `reading` }))).toBeUndefined();
        expect(boxAttention(box({ readAt: undefined, state: `unreachable` }))).toBeUndefined();
    });

    // A box that has answered and gone quiet keeps its last count rather than falling back to unknown.
    it("keeps the last real count for a box that has since gone quiet", () => {
        const blocked = agent({ attention: { ...none, question: true } });
        expect(boxAttention(box({ state: `unreachable`, agents: [blocked] }))).toBe(1);
    });

    it("counts an agent parked on a question", () => {
        expect(boxAttention(box({ agents: [agent({ attention: { ...none, permission: true } })] }))).toBe(1);
    });

    // The daemon holds the read marker (seenAt), meaning the same thing at a distance as up close.
    it("counts an agent that has worked since it was last opened", () => {
        expect(boxAttention(box({ agents: [agent({ updatedAt: 500, seenAt: 100 })] }))).toBe(1);
    });

    // A running agent's ticking updatedAt must not light the count; the reading is "finished, unread."
    it("does not count a turn that is still running", () => {
        expect(boxAttention(box({ agents: [agent({ status: `running`, updatedAt: 500, seenAt: 100 })] }))).toBe(0);
    });

    // One agent that is both blocked and unread badges once, same as the local reading.
    it("counts an agent once when it is both blocked and unread", () => {
        expect(boxAttention(box({ agents: [agent({ attention: { ...none, plan: true }, updatedAt: 500, seenAt: 100 })] }))).toBe(1);
    });

    // A held wake needs the owner as much as a parked agent does; nothing else here can see one in another box.
    it("adds the automation wakes waiting for a yes", () => {
        expect(boxAttention(box({ agents: [], held: [{ id: `hold-1` }] as never }))).toBe(1);
    });

    it("says zero, not unknown, for a box that answered with nothing waiting", () => {
        expect(boxAttention(box({ agents: [agent({ updatedAt: 100, seenAt: 500 })] }))).toBe(0);
    });
});

// `useAgents.markSeen` is a no-op for an agent in another box, since it only writes the roster this browser streams;
// that stopped being safe once a conversation could be held here and run there.
describe("marking an agent in another box as read", () => {
    const roster = (over: Partial<AgentSummary> = {}): { agents: AgentSummary[]; rev: number } => ({
        agents: [agent({ id: `a1`, updatedAt: 500, seenAt: 100, ...over })],
        rev: 1,
    });

    it("stamps this browser's copy and tells that box's own daemon", async () => {
        sandboxes.value = [
            { id: `sbx-here`, name: `Desk`, lastSeenAt: `2026-01-01T00:00:00Z` },
            { id: `sbx-other`, name: `Laptop`, lastSeenAt: `2026-01-01T00:00:00Z` },
        ];
        sandboxJsonQuietly.mockResolvedValue(roster());
        const release = subscribe();
        await vi.waitFor(() => expect(otherBoxes.value[0]?.state).toBe(`ready`));
        expect(boxAttention(otherBoxes.value[0]!)).toBe(1);

        markSeenAcross(`sbx-other`, `a1`);

        // The next poll is up to 45 seconds out; a count still lit that long looks indistinguishable from stuck.
        expect(boxAttention(otherBoxes.value[0]!)).toBe(0);
        expect(sandboxJsonQuietly).toHaveBeenCalledWith(`sbx-other`, `/agents/a1/seen`, { method: `POST` });
        release();
    });

    // A box never read has no copy to stamp; writing to it would claim a roster nothing here has seen.
    it("says nothing to a box it has never read", () => {
        sandboxJsonQuietly.mockClear();
        markSeenAcross(`sbx-unknown`, `a1`);
        expect(sandboxJsonQuietly).not.toHaveBeenCalled();
    });
});
