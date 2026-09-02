import { afterEach, expect, test, vi } from "vitest";
import { CI_FIX_PREFIX, ciFixConversationId, newConversationId } from "./conversation-ids.js";
import { ConversationIdSchema } from "./schemas/agent.js";

const mockRandomValues = (values: readonly number[]) => {
    const remaining = [...values];
    const getRandomValues = vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (!(array instanceof Uint32Array)) {
            throw new TypeError(`Expected a Uint32Array`);
        }
        const value = remaining.shift();
        if (value === undefined) {
            throw new Error(`No mocked random value remains`);
        }
        array[0] = value;
        return array;
    });
    return { getRandomValues, remaining };
};

afterEach(() => vi.restoreAllMocks());

// The one property that is not a matter of taste: this string becomes a git branch and a filesystem path, and
// the id guard is what stands between those and an injection. Held over a large sample rather than one draw,
// because the generator picks from three independent spaces and any of them could produce the bad character.
test("every generated id passes the conversation-id guard", () => {
    for (let index = 0; index < 2_000; index += 1) {
        expect(ConversationIdSchema.safeParse(newConversationId()).success).toBe(true);
    }
});

test("an id reads as a word pair with a short tail, and stays short", () => {
    const id = newConversationId();
    expect(id).toMatch(/^[a-z]+-[a-z]+-[0-9a-z]{4}$/);
    // Comfortably under a UUID's 36, which is the whole reason this exists.
    expect(id.length).toBeLessThan(24);
});

test("retries a random draw outside the last complete bucket", () => {
    const bucketSize = Math.floor(2 ** 32 / 36);
    const { getRandomValues, remaining } = mockRandomValues([0, 0, 0xffff_ffff, 0, bucketSize, bucketSize * 2, bucketSize * 3]);

    expect(newConversationId()).toBe(`amber-alder-0123`);
    expect(getRandomValues).toHaveBeenCalledTimes(7);
    expect(remaining).toEqual([]);
});

test("maps complete random buckets to equal-width base36 characters", () => {
    const bucketSize = Math.floor(2 ** 32 / 36);
    const limit = bucketSize * 36;
    const { remaining } = mockRandomValues([0, 0, bucketSize - 1, bucketSize, bucketSize * 35, limit - 1]);

    expect(newConversationId()).toBe(`amber-alder-01zz`);
    expect(remaining).toEqual([]);
});

// The tail is what makes the readable half safe to repeat: names may rhyme, ids may not.
test("ids are unique across a burst", () => {
    const ids = new Set(Array.from({ length: 5_000 }, newConversationId));
    expect(ids.size).toBe(5_000);
});

// The whole point of the derived id: the same failure names the same conversation, forever, from any browser.
test("a CI fix id is the same string every time it is derived", () => {
    expect(ciFixConversationId(`web`, 4213)).toBe(`ci-fix-web-4213`);
    expect(ciFixConversationId(`web`, 4213)).toBe(ciFixConversationId(`web`, 4213));
});

// A run id belongs to one forge project, not to the workspace: without the repo, two repos' run 42 would share
// an agent, and the second failure would be answered by the first one's conversation.
test("two repos with the same run number get different conversations", () => {
    expect(ciFixConversationId(`web`, 42)).not.toBe(ciFixConversationId(`api`, 42));
});

// The id becomes a branch and a path, so the guard is not a matter of taste. Held over the repo names a
// workspace can actually produce: nested dirs, dots, spaces, punctuation, and something that slugs to nothing.
test("every derived id passes the conversation-id guard", () => {
    const repos = [`root`, `web`, `apps/web`, `my repo`, `.dotted`, `UPPER_Case`, `___`, `x`.repeat(80)];
    for (const repo of repos) {
        for (const runId of [1, 42, 18_446_744_073]) {
            const id = ciFixConversationId(repo, runId);
            expect(ConversationIdSchema.safeParse(id).success).toBe(true);
            expect(id.startsWith(CI_FIX_PREFIX)).toBe(true);
        }
    }
});

// The join is a prefix scan over the fleet, so the prefix has to survive a repo name that starts with one.
test("the prefix is carried by every fix id", () => {
    expect(ciFixConversationId(`ci-fix`, 7)).toBe(`ci-fix-ci-fix-7`);
});
