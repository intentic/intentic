import { afterEach, expect, test, vi } from "vitest";
import { CI_FIX_PREFIX, ciFixConversationId, newConversationId, PUSH_FIX_PREFIX, pushFixConversationId } from "./conversation-ids.js";
import { ConversationIdSchema } from "../schemas/agent.js";

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

test("every generated id passes the conversation-id guard", () => {
    for (let index = 0; index < 2_000; index += 1) {
        expect(ConversationIdSchema.safeParse(newConversationId()).success).toBe(true);
    }
});

test("an id reads as a word pair with a short tail, and stays short", () => {
    const id = newConversationId();
    expect(id).toMatch(/^[a-z]+-[a-z]+-[0-9a-z]{4}$/);
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

test("ids are unique across a burst", () => {
    const ids = new Set(Array.from({ length: 5_000 }, newConversationId));
    expect(ids.size).toBe(5_000);
});

test("a CI fix id is the same string every time it is derived", () => {
    expect(ciFixConversationId(`web`, 4213)).toBe(`ci-fix-web-4213`);
    expect(ciFixConversationId(`web`, 4213)).toBe(ciFixConversationId(`web`, 4213));
});

test("two repos with the same run number get different conversations", () => {
    expect(ciFixConversationId(`web`, 42)).not.toBe(ciFixConversationId(`api`, 42));
});

// Repo names cover what a workspace can produce: nested dirs, dots, spaces, punctuation, a name slugging empty.
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

test("the prefix is carried by every fix id", () => {
    expect(ciFixConversationId(`ci-fix`, 7)).toBe(`ci-fix-ci-fix-7`);
});

test("a push fix id is the same string every time the same failure derives it", () => {
    expect(pushFixConversationId(`intentic`, `checkout gates,lint`)).toBe(pushFixConversationId(`intentic`, `checkout gates,lint`));
    expect(pushFixConversationId(`intentic`, `checkout gates,lint`)).toMatch(/^push-fix-intentic-[0-9a-z]{7}$/);
});

test("a push fix id separates failures and scopes", () => {
    expect(pushFixConversationId(`intentic`, `lint`)).not.toBe(pushFixConversationId(`intentic`, `checkout gates`));
    expect(pushFixConversationId(`web`, `lint`)).not.toBe(pushFixConversationId(`api`, `lint`));
});

// Signatures cover raw gate output: control characters, unicode, path-like strings, and pathological lengths.
test("every derived push fix id passes the conversation-id guard", () => {
    const signatures = [``, `checkout gates`, `✗ lint · pnpm lint`, `a`.repeat(4_000), `../../etc/passwd`, `a\nb\tc`, `résumé`];
    for (const scope of [`root`, `apps/web`, `my repo`, `___`, `x`.repeat(80)]) {
        for (const signature of signatures) {
            const id = pushFixConversationId(scope, signature);
            expect(ConversationIdSchema.safeParse(id).success).toBe(true);
            expect(id.startsWith(PUSH_FIX_PREFIX)).toBe(true);
        }
    }
});
