import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { AgentSummary } from "@intentic/sandbox-contract";

/* The cross-sandbox reader, exercised through its pure half: the reading it makes of one box's roster and the
 * one thing it must never do, which is turn a failed read into a zero.
 *
 * The store's own polling is not simulated here. What is worth pinning is the DERIVATION, because it is the
 * number that ends up on a switcher row and on the rail's badge after a switch, and those two disagreeing is
 * the failure this shares its predicates with useAgents to avoid. */

// Cut the edges that want a browser at module-eval, the way useAgents.test.ts does: this module reaches the
// shared query client (for the entry it files each read under) and the sandbox client, neither of which the
// derivation under test touches.
const sandboxes = ref<{ id: string; name: string; lastSeenAt: string | null }[]>([]);
const activeSandboxId = ref<string | undefined>(`sbx-here`);
vi.mock("./useSandbox", () => ({ useSandbox: () => ({ sandboxes, activeSandboxId }) }));
const sandboxJsonQuietly = vi.fn();
vi.mock("./sandboxClient", () => ({ sandboxJsonQuietly }));
vi.mock("../queryPersistence", () => ({ queryClient: { setQueryData: vi.fn() } }));

const { boxAttention, markSeenAcross, otherBoxes, subscribe } = await import("./fleetAcross");
type BoxFleet = Parameters<typeof boxAttention>[0];

const none = { plan: false, question: false, permission: false, service: false, capability: false, conflict: false };
const agent = (over: Partial<AgentSummary>): AgentSummary =>
    ({ id: `a1`, status: `idle`, provider: `claude`, harness: `claude-code`, updatedAt: 1, attention: none, ...over }) as AgentSummary;

const box = (over: Partial<BoxFleet>): BoxFleet =>
    ({ sandbox: { id: `sbx-other`, name: `Laptop` }, state: `ready`, agents: [], held: [], readAt: 1000, ...over }) as BoxFleet;

describe("what one other box is holding for its owner", () => {
    /* THE ONE THAT MATTERS MOST. A box that has never answered has no count, and rendering that as `0` would
     * say "nothing is waiting for you here" on the strength of a request that failed. Every surface reading
     * this draws a dash instead, which is the same mistake `live: true` made in the deployments design. */
    it("has no answer at all for a box that has never been read", () => {
        expect(boxAttention(box({ readAt: undefined, state: `reading` }))).toBeUndefined();
        expect(boxAttention(box({ readAt: undefined, state: `unreachable` }))).toBeUndefined();
    });

    // ...and a box that HAS answered and is now unreachable keeps its last count rather than falling back to
    // unknown: it was true when it was read, and forgetting it is not more honest than reporting it stale.
    it("keeps the last real count for a box that has since gone quiet", () => {
        const blocked = agent({ attention: { ...none, question: true } });
        expect(boxAttention(box({ state: `unreachable`, agents: [blocked] }))).toBe(1);
    });

    it("counts an agent parked on a question", () => {
        expect(boxAttention(box({ agents: [agent({ attention: { ...none, permission: true } })] }))).toBe(1);
    });

    // The daemon holds the read marker (seenAt), not this browser, so "worked since you last opened it" means
    // the same thing at a distance as it does up close.
    it("counts an agent that has worked since it was last opened", () => {
        expect(boxAttention(box({ agents: [agent({ updatedAt: 500, seenAt: 100 })] }))).toBe(1);
    });

    // A turn in flight is not news: the reading is "finished with something unread", so a running agent whose
    // updatedAt ticks every second must not light up the count for as long as it runs.
    it("does not count a turn that is still running", () => {
        expect(boxAttention(box({ agents: [agent({ status: `running`, updatedAt: 500, seenAt: 100 })] }))).toBe(0);
    });

    // One agent that is both blocked AND unread badges once, the same as the local reading.
    it("counts an agent once when it is both blocked and unread", () => {
        expect(boxAttention(box({ agents: [agent({ attention: { ...none, plan: true }, updatedAt: 500, seenAt: 100 })] }))).toBe(1);
    });

    // A wake held at the door needs the owner exactly as much as a parked agent does, and nothing else in this
    // browser can learn about one in a box it is not pointed at.
    it("adds the automation wakes waiting for a yes", () => {
        expect(boxAttention(box({ agents: [], held: [{ id: `hold-1` }] as never }))).toBe(1);
    });

    it("says zero, not unknown, for a box that answered with nothing waiting", () => {
        expect(boxAttention(box({ agents: [agent({ updatedAt: 100, seenAt: 500 })] }))).toBe(0);
    });
});

/* READING ONE OF THOSE AGENTS FROM HERE. `useAgents.markSeen` writes the roster this browser streams and so is
 * a no-op for an agent in another box, which was fine while a distant agent could only be looked at on a card
 * and stopped being fine when a conversation could be held here and run there (Conversation.box): the chat in
 * front of the user would have gone on counting toward "needs you" for good. */
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

        // The optimistic half: the next poll is up to 45 seconds out, and a count still lit that long after the
        // user read the thing is indistinguishable from one that is stuck.
        expect(boxAttention(otherBoxes.value[0]!)).toBe(0);
        expect(sandboxJsonQuietly).toHaveBeenCalledWith(`sbx-other`, `/agents/a1/seen`, { method: `POST` });
        release();
    });

    // A box this store has never read has no copy to stamp, and writing to it would be a claim about a roster
    // nothing here has seen.
    it("says nothing to a box it has never read", () => {
        sandboxJsonQuietly.mockClear();
        markSeenAcross(`sbx-unknown`, `a1`);
        expect(sandboxJsonQuietly).not.toHaveBeenCalled();
    });
});
