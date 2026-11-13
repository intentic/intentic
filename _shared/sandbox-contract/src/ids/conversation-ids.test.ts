import {
    CI_FIX_PREFIX,
    CONVERSATION_ID,
    HOME_PREFIX,
    LAND_FIX_PREFIX,
    LINKED_PREFIX,
    LINK_CONVERSATION_PREFIX,
    looksDrawn,
    SUBAGENT_PREFIX,
    TAIL_ALPHABET,
    homeConversationId,
    isHomeConversationId,
    legacyCiFixConversationId,
    ciFixBase,
    ciFixConversationId,
    fixAttemptId,
    fixAttemptOf,
    isCiFixConversationId,
    fixAttemptsOf,
    latestFixAttempt,
    newConversationId,
    nextFixAttemptId,
} from "./conversation-ids.js";
import { CONVERSATION_WORDS } from "./conversation-words.js";
import { ConversationIdSchema } from "../schemas/agent.js";

const mockRandomValues = (values: readonly number[]) => {
    const remaining = [...values];
    const getRandomValues = jest.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
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

afterEach(() => jest.restoreAllMocks());

test("every generated id passes the conversation-id guard", () => {
    for (let index = 0; index < 2_000; index += 1) {
        expect(ConversationIdSchema.safeParse(newConversationId()).success).toBe(true);
    }
});

test("an id reads as one word and a short tail, and stays short", () => {
    const id = newConversationId();
    expect(id).toMatch(/^[a-z]{3,6}-[2-9a-hjkmnp-z]{4}$/);
    expect(id.length).toBeLessThanOrEqual(11);
});

test("the tail never uses a character people misread", () => {
    expect(TAIL_ALPHABET).toHaveLength(31);
    expect(TAIL_ALPHABET).not.toMatch(/[01ilo]/);
});

test("every word is a short lowercase word, listed once", () => {
    expect(CONVERSATION_WORDS.length).toBeGreaterThan(500);
    expect(new Set(CONVERSATION_WORDS).size).toBe(CONVERSATION_WORDS.length);
    for (const word of CONVERSATION_WORDS) {
        expect(word).toMatch(/^[a-z]{3,6}$/);
    }
});

// A drawn id must never read as a derived one (`home-…`, `fix-…`, `sub-…`) or as a git ref. Every prefix a
// conversation id is minted under is listed, wherever it is minted: fix agents, home, subagents and links (this file's
// module), automation fires (`a-`), workflow steps (`wf-`), the public doors (`wc-` Visitor chat, `bug-` issue
// intake), extension update reviews (`upd-`) and the batch packs (`xt-`, `dg-`, `mt-`). Then the neighbours a
// drawn id would be mistaken for: a borrowed account (`lent-`) and a watch (`watch-k7mq` is its exact shape).
test("no word collides with a derived id's prefix or a git name", () => {
    const prefixes = [
        HOME_PREFIX,
        CI_FIX_PREFIX,
        LAND_FIX_PREFIX,
        SUBAGENT_PREFIX,
        LINK_CONVERSATION_PREFIX,
        LINKED_PREFIX,
        "a-",
        "wf-",
        "wc-",
        "bug-",
        "upd-",
        "xt-",
        "dg-",
        "mt-",
        "lent-",
        "watch-",
    ];
    const reserved = prefixes.map((prefix) => prefix.split("-")[0]);
    for (const word of [...reserved, "main", "master", "head", "fork", "branch", "merge", "patch", "tag"]) {
        expect(CONVERSATION_WORDS).not.toContain(word);
    }
});

test("retries a random draw outside the last complete bucket", () => {
    const bucketSize = Math.floor(2 ** 32 / 31);
    const { getRandomValues, remaining } = mockRandomValues([0, 0xffff_ffff, 0, bucketSize, bucketSize * 2, bucketSize * 3]);

    expect(newConversationId()).toBe(`${CONVERSATION_WORDS[0]}-2345`);
    expect(getRandomValues).toHaveBeenCalledTimes(6);
    expect(remaining).toEqual([]);
});

test("maps complete random buckets to equal-width tail characters", () => {
    const bucketSize = Math.floor(2 ** 32 / 31);
    const limit = bucketSize * 31;
    const { remaining } = mockRandomValues([0, bucketSize - 1, bucketSize, bucketSize * 30, limit - 1]);

    expect(newConversationId()).toBe(`${CONVERSATION_WORDS[0]}-23zz`);
    expect(remaining).toEqual([]);
});

test("a drawn id, new or old, looks drawn; a route or a derived id does not", () => {
    expect(looksDrawn(newConversationId())).toBe(true);
    expect(looksDrawn(`otter-kmpq`)).toBe(true);
    expect(looksDrawn(`keen-pine-tkjf`)).toBe(true);
    expect(looksDrawn(`git-view`)).toBe(false);
    expect(looksDrawn(`otter-km0q`)).toBe(false);
    expect(looksDrawn(ciFixConversationId(`web`, 42))).toBe(false);
});

// A subagent's and a link's conversations are drawn ids under a prefix, and their tails carry no digit about a third
// of the time, so the prefix must not hide them.
test("a drawn id under a subagent or link prefix still looks drawn, in either generation", () => {
    for (const prefix of [SUBAGENT_PREFIX, LINK_CONVERSATION_PREFIX, LINKED_PREFIX]) {
        expect(looksDrawn(`${prefix}${newConversationId()}`)).toBe(true);
        expect(looksDrawn(`${prefix}otter-kmpq`)).toBe(true);
        expect(looksDrawn(`${prefix}keen-pine-tkjf`)).toBe(true);
        expect(looksDrawn(`${prefix}view`)).toBe(false);
    }
});

test("ids are unique across a burst", () => {
    const ids = new Set(Array.from({ length: 5_000 }, newConversationId));
    expect(ids.size).toBe(5_000);
});

test("a CI fix id is the same string every time it is derived", () => {
    expect(ciFixConversationId(`web`, 4213)).toBe(`fix-web-391`);
    // The id the screenshot that asked for this carried, `ci-fix-intentic-42991360694-attempt5`, now reads:
    expect(fixAttemptId(ciFixConversationId(`intentic`, 42_991_360_694), 5)).toBe(`fix-intentic-jqzy27q_5`);
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

test("a fix agent is told apart by its id, whichever shape it was minted in", () => {
    expect(isCiFixConversationId(ciFixConversationId(`web`, 41))).toBe(true);
    expect(isCiFixConversationId(`ci-fix-intentic-42991360694-attempt5`)).toBe(true);
    // The gate CLI's own conversations, and a drawn id.
    expect(isCiFixConversationId(`ci-42991360694-1`)).toBe(false);
    expect(isCiFixConversationId(`otter-k7mq`)).toBe(false);
});

test("the prefix is carried by every fix id", () => {
    expect(ciFixConversationId(`ci-fix`, 7)).toBe(`fix-ci-fix-7`);
});

// Attempt 1 is the bare derived id, so every fix conversation minted before attempts existed reads as attempt 1.
test("the first attempt wears the failure's own id, later ones carry their number", () => {
    const base = ciFixConversationId(`web`, 41);
    expect(fixAttemptId(base, 1)).toBe(base);
    expect(fixAttemptId(base, 2)).toBe(`fix-web-15_2`);
    expect(fixAttemptOf(base, base)).toBe(1);
    expect(fixAttemptOf(base, `fix-web-15_2`)).toBe(2);
    expect(fixAttemptOf(base, `fix-web-15_12`)).toBe(12);
});

// Read base-relative on purpose: a base ends in a run id, so a neighbouring failure's id can start with this one.
test("another failure's id is not an attempt at this one", () => {
    const base = ciFixConversationId(`web`, 41);
    // Repo `web-15`, run 2: starts with the base and a dash, and is nobody's attempt.
    expect(fixAttemptOf(base, ciFixConversationId(`web-15`, 2))).toBeUndefined();
    expect(fixAttemptOf(base, ciFixConversationId(`web`, 41 * 36))).toBeUndefined();
    expect(fixAttemptOf(base, `swift-otter-k9m2`)).toBeUndefined();
    // One spelling per attempt.
    expect(fixAttemptOf(base, `fix-web-15_1`)).toBeUndefined();
    expect(fixAttemptOf(base, `fix-web-15_02`)).toBeUndefined();
    expect(fixAttemptOf(base, `fix-web-15_`)).toBeUndefined();
});

test("attempts are read off the roster, earliest first, and the newest is the live answer", () => {
    const base = ciFixConversationId(`intentic`, 7);
    const roster = [{ id: `swift-otter-k9m2` }, { id: fixAttemptId(base, 3) }, { id: base }, { id: ciFixConversationId(`intentic`, 8) }];
    expect(fixAttemptsOf(base, roster).map((entry) => entry.attempt)).toEqual([1, 3]);
    expect(latestFixAttempt(base, roster)?.agent.id).toBe(fixAttemptId(base, 3));
    expect(latestFixAttempt(base, [])).toBeUndefined();
});

// The archive counts: a start-over files the last attempt away, and re-minting its number would un-archive it.
test("the next attempt is numbered past every known one, archived included", () => {
    const base = ciFixConversationId(`web`, 41);
    expect(nextFixAttemptId(base, [])).toBe(base);
    expect(nextFixAttemptId(base, [base])).toBe(`fix-web-15_2`);
    expect(nextFixAttemptId(base, [`fix-web-15_3`, `swift-otter-k9m2`])).toBe(`fix-web-15_4`);
    expect(nextFixAttemptId(base, [ciFixConversationId(`web-15`, 2)])).toBe(base);
});

test("an attempt id passes the guard and fits, even for the widest run id a forge mints", () => {
    const widest = ciFixConversationId(`a-repository-name-of-thirty-two-chars-or-more`, 99_999_999_999);
    for (const attempt of [1, 2, 99]) {
        const id = fixAttemptId(widest, attempt);
        expect(ConversationIdSchema.safeParse(id).success).toBe(true);
        expect(id.length).toBeLessThanOrEqual(64);
    }
});

// Fix agents minted before the ids were shortened (2026-11-12) still answer their failures: the board found none of them
// after the change, and offered Fix with agent beside a failure two agents had already worked.
test("a run fixed before the ids were shortened keeps its own family", () => {
    const legacy = legacyCiFixConversationId(`intentic`, 43_301_660_752);
    expect(legacy).toBe(`ci-fix-intentic-43301660752`);
    expect(fixAttemptOf(legacy, `ci-fix-intentic-43301660752-attempt2`)).toBe(2);
    // An attempt minted after the change, on the family the legacy base began.
    expect(fixAttemptOf(legacy, fixAttemptId(legacy, 3))).toBe(3);
    expect(latestFixAttempt(legacy, [{ id: legacy }, { id: `ci-fix-intentic-43301660752-attempt2` }])?.attempt).toBe(2);
    expect(ciFixBase(`intentic`, 43_301_660_752, [`ci-fix-intentic-43301660752-attempt2`])).toBe(legacy);
    expect(ciFixBase(`intentic`, 43_301_660_752, [`swift-otter-k9m2`])).toBe(ciFixConversationId(`intentic`, 43_301_660_752));
});

test("the legacy attempt mark is read only on the bases that once carried it", () => {
    const base = ciFixConversationId(`web`, 41);
    expect(fixAttemptOf(base, `${base}-attempt2`)).toBeUndefined();
    // Another legacy run's id is no attempt: `-attempt` never follows a decimal run id inside a base.
    expect(fixAttemptOf(legacyCiFixConversationId(`web`, 41), legacyCiFixConversationId(`web-41`, 2))).toBeUndefined();
});

// One home conversation per member, derived from who they are: the same in every browser and in the daemon, whatever the
// email's case, a valid conversation id, and never the email itself.
test("a home conversation id is its member's alone, stable and folded, and says nothing of the address", () => {
    const ada = homeConversationId("ada@example.com");
    expect(homeConversationId(" Ada@Example.COM ")).toBe(ada);
    expect(homeConversationId("bob@example.com")).not.toBe(ada);
    expect(CONVERSATION_ID.test(ada)).toBe(true);
    expect(isHomeConversationId(ada)).toBe(true);
    expect(isHomeConversationId(newConversationId())).toBe(false);
    expect(ada).not.toContain("ada");
});
