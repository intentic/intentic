import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { blessedList, blessedListReadAt, forgetBlessedList, lowestSatisfying, targetVersion } from "./engine-channel.js";
import type { EngineState } from "./engine-store.js";

/* WHICH VERSION A CHANNEL ASKS FOR, and what happens when the answers cannot be reached.
 *
 * Every read here is over the network in production, so every case stubs it: what is being pinned is the
 * policy, not npm. The one rule that matters more than the rest is the last pair — an unreachable list or
 * registry must leave a sandbox running exactly what it runs now, because an update mechanism that can break a
 * working sandbox by being offline is worse than no update mechanism at all. */

const CLEAN: EngineState = { quarantined: [] };

const jsonResponse = (body: unknown, init?: { status?: number; etag?: string }): Response =>
    new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: init?.etag === undefined ? {} : { etag: init.etag },
    });

beforeEach(() => {
    forgetBlessedList();
    process.env["INTENTIC_ENGINES_LIST_URL"] = "https://example.test/engines.json";
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["INTENTIC_ENGINES_LIST_URL"];
    forgetBlessedList();
});

test("the image channel asks for nothing at all", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(await targetVersion("claude", { kind: "image" }, CLEAN)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
});

test("a pin is the answer, without asking anybody", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(await targetVersion("claude", { kind: "pinned", version: "0.3.240" }, CLEAN)).toBe("0.3.240");
    expect(fetch).not.toHaveBeenCalled();
});

test("the blessed channel takes what the list names", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { claude: { blessed: "0.3.257" } } })));
    expect(await targetVersion("claude", { kind: "blessed" }, CLEAN)).toBe("0.3.257");
});

test("the latest channel takes upstream's own newest", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ "dist-tags": { latest: "0.3.260" }, versions: { "0.3.260": {} } })));
    expect(await targetVersion("claude", { kind: "latest" }, CLEAN)).toBe("0.3.260");
});

/* A version this daemon has already installed and refused is not offered again. Without this, an upstream that
 * publishes a broken `latest` produces a card asking for the same failed download forever, and a daily check
 * that keeps performing it. */
test("a version already refused here is not offered again", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { claude: { blessed: "0.3.257" } } })));
    const refused: EngineState = { quarantined: [{ version: "0.3.257", reason: "would not launch", at: "2026-09-01T00:00:00.000Z" }] };
    expect(await targetVersion("claude", { kind: "blessed" }, refused)).toBeUndefined();
});

/* THE FLOOR IS STATED IN THE CLI'S VOCABULARY AND THE REGISTRY IN npm's. Anthropic ships sdk 0.3.N as Claude
 * Code 2.1.N, so a floor of 2.1.251 selects 0.3.251 — and the ordinary comparison, which would answer "no
 * published version is at or above 2.1.251", is exactly the bug this mapping exists to prevent. */
test("a CLI-versioned floor selects the lowest npm version that ships it", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
            jsonResponse({ "dist-tags": { latest: "0.3.260" }, versions: { "0.3.233": {}, "0.3.251": {}, "0.3.257": {}, "0.3.260": {} } }),
        ),
    );
    expect(await lowestSatisfying("claude", "2.1.251")).toBe("0.3.251");
});

test("a floor stated in the package's own numbers still compares normally", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ versions: { "0.3.233": {}, "0.3.251": {}, "0.3.257": {} } })));
    expect(await lowestSatisfying("claude", "0.3.251")).toBe("0.3.251");
});

test("the smallest step is taken, not the newest release", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ versions: { "1.0.0": {}, "1.2.0": {}, "1.5.0": {} } })));
    expect(await lowestSatisfying("opencode", "1.2.0")).toBe("1.2.0");
});

/* A LIST THAT WAS READ ONCE STANDS WHEN GITHUB IS DOWN. The alternative — forgetting what is blessed because a
 * refresh failed — turns somebody else's outage into this sandbox falling off its channel. */
test("a failed refresh keeps the last list that was read", async () => {
    const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ engines: { claude: { blessed: "0.3.257" } } }, { etag: `"abc"` }))
        .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    expect((await blessedList())?.entries.claude?.blessed).toBe("0.3.257");
    expect((await blessedList(true))?.entries.claude?.blessed).toBe("0.3.257");
});

test("an unreachable list is not a version, and says so by having no read time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await blessedList()).toBeUndefined();
    expect(blessedListReadAt()).toBeUndefined();
    expect(await targetVersion("claude", { kind: "blessed" }, CLEAN)).toBeUndefined();
});

// The conditional request is the reason this can run hourly on every sandbox without being rude: after the
// first read the list is asked for with its etag and answers 304 nearly every time.
test("a re-read is conditional on the etag it already holds", async () => {
    const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ engines: { claude: { blessed: "0.3.257" } } }, { etag: `"abc"` }))
        .mockResolvedValueOnce(new Response(undefined, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    await blessedList();
    await blessedList(true);

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { "if-none-match": `"abc"` } });
    expect((await blessedList())?.entries.claude?.blessed).toBe("0.3.257");
});

// A rewritten or half-published list reads as no list rather than as a version: whatever it would have named
// is code every turn in the sandbox then runs.
test("a list that does not parse is ignored", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { claude: { blessed: 257 } } })));
    expect(await blessedList()).toBeUndefined();
});
