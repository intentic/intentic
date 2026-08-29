import { afterEach, expect, test, vi } from "vitest";
import { newConversationId } from "./conversation-ids.js";
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
