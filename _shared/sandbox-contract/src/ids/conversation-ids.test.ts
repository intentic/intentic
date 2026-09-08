import { afterEach, expect, test, vi } from "vitest";
import {
    CI_FIX_PREFIX,
    ciFixConversationId,
    fixAttemptId,
    fixAttemptOf,
    fixAttemptsOf,
    latestFixAttempt,
    newConversationId,
    nextFixAttemptId,
    PUSH_FIX_PREFIX,
    pushFixConversationId,
} from "./conversation-ids.js";
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

// Attempt 1 is the bare derived id, so every fix conversation minted before attempts existed reads as attempt 1.
test("the first attempt wears the failure's own id, later ones carry their number", () => {
    const base = ciFixConversationId(`web`, 41);
    expect(fixAttemptId(base, 1)).toBe(base);
    expect(fixAttemptId(base, 2)).toBe(`ci-fix-web-41-attempt2`);
    expect(fixAttemptOf(base, base)).toBe(1);
    expect(fixAttemptOf(base, `ci-fix-web-41-attempt2`)).toBe(2);
    expect(fixAttemptOf(base, `ci-fix-web-41-attempt12`)).toBe(12);
});

// Read base-relative on purpose: a base ends in a run id, so a neighbouring failure's id can start with this one.
test("another failure's id is not an attempt at this one", () => {
    const base = ciFixConversationId(`web`, 41);
    // Repo `web-41`, run 2: starts with the base and a dash, and is nobody's attempt.
    expect(fixAttemptOf(base, ciFixConversationId(`web-41`, 2))).toBeUndefined();
    expect(fixAttemptOf(base, ciFixConversationId(`web`, 412))).toBeUndefined();
    expect(fixAttemptOf(base, `swift-otter-k9m2`)).toBeUndefined();
    // One spelling per attempt.
    expect(fixAttemptOf(base, `ci-fix-web-41-attempt1`)).toBeUndefined();
    expect(fixAttemptOf(base, `ci-fix-web-41-attempt02`)).toBeUndefined();
    expect(fixAttemptOf(base, `ci-fix-web-41-attempt`)).toBeUndefined();
});

test("attempts are read off the roster, earliest first, and the newest is the live answer", () => {
    const base = pushFixConversationId(`intentic`, `lint`);
    const roster = [{ id: `swift-otter-k9m2` }, { id: fixAttemptId(base, 3) }, { id: base }, { id: pushFixConversationId(`intentic`, `typecheck`) }];
    expect(fixAttemptsOf(base, roster).map((entry) => entry.attempt)).toEqual([1, 3]);
    expect(latestFixAttempt(base, roster)?.agent.id).toBe(fixAttemptId(base, 3));
    expect(latestFixAttempt(base, [])).toBeUndefined();
});

// The archive counts: a start-over files the last attempt away, and re-minting its number would un-archive it.
test("the next attempt is numbered past every known one, archived included", () => {
    const base = ciFixConversationId(`web`, 41);
    expect(nextFixAttemptId(base, [])).toBe(base);
    expect(nextFixAttemptId(base, [base])).toBe(`ci-fix-web-41-attempt2`);
    expect(nextFixAttemptId(base, [`ci-fix-web-41-attempt3`, `swift-otter-k9m2`])).toBe(`ci-fix-web-41-attempt4`);
    expect(nextFixAttemptId(base, [ciFixConversationId(`web-41`, 2)])).toBe(base);
});

test("an attempt id passes the guard and fits, even for the widest run id a forge mints", () => {
    const widest = ciFixConversationId(`a-repository-name-of-thirty-two-chars-or-more`, 99_999_999_999);
    for (const attempt of [1, 2, 99]) {
        const id = fixAttemptId(widest, attempt);
        expect(ConversationIdSchema.safeParse(id).success).toBe(true);
        expect(id.length).toBeLessThanOrEqual(64);
    }
});
