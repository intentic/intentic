import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { blessedList, blessedListReadAt, forgetUpstream, lowestSatisfying, recordedSha256, targetVersion } from "./engine-channel.js";
import { releaseArch } from "./engine-descriptors.js";
import type { EngineState } from "./engine-store.js";

// Pins channel-selection policy against stubbed network responses, not real npm; an unreachable list or registry must
// leave a sandbox running its current version.

const CLEAN: EngineState = { quarantined: [] };

const jsonResponse = (body: unknown, init?: { status?: number; etag?: string }): Response =>
    new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: init?.etag === undefined ? {} : { etag: init.etag },
    });

beforeEach(() => {
    forgetUpstream();
    process.env["INTENTIC_ENGINES_LIST_URL"] = "https://example.test/engines.json";
});

afterEach(() => {
    unstubAllGlobals();
    delete process.env["INTENTIC_ENGINES_LIST_URL"];
    forgetUpstream();
});

test("the image channel asks for nothing at all", async () => {
    stubGlobal("fetch", jest.fn());
    expect(await targetVersion("claude", { kind: "image" }, CLEAN)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
});

test("a pin is the answer, without asking anybody", async () => {
    stubGlobal("fetch", jest.fn());
    expect(await targetVersion("claude", { kind: "pinned", version: "0.3.240" }, CLEAN)).toBe("0.3.240");
    expect(fetch).not.toHaveBeenCalled();
});

test("the blessed channel takes what the list names", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(jsonResponse({ engines: { claude: { blessed: "0.3.257" } } })));
    expect(await targetVersion("claude", { kind: "blessed" }, CLEAN)).toBe("0.3.257");
});

test("the latest channel takes upstream's own newest", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(jsonResponse({ "dist-tags": { latest: "0.3.260" }, versions: { "0.3.260": {} } })));
    expect(await targetVersion("claude", { kind: "latest" }, CLEAN)).toBe("0.3.260");
});

// The card, every tab and each Update-all step read the same answer.
test("one registry answer serves repeated reads of the latest channel", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ "dist-tags": { latest: "0.3.260" }, versions: { "0.3.260": {} } }));
    stubGlobal("fetch", fetchMock);
    const reads = await Promise.all([1, 2, 3].map(() => targetVersion("claude", { kind: "latest" }, CLEAN)));
    expect(reads).toEqual(["0.3.260", "0.3.260", "0.3.260"]);
    expect(await targetVersion("claude", { kind: "latest" }, CLEAN)).toBe("0.3.260");
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("an unreachable registry is asked again on the next read, not remembered as nothing on offer", async () => {
    const fetchMock = jest
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "0.3.260" }, versions: { "0.3.260": {} } }));
    stubGlobal("fetch", fetchMock);
    expect(await targetVersion("claude", { kind: "latest" }, CLEAN)).toBeUndefined();
    expect(await targetVersion("claude", { kind: "latest" }, CLEAN)).toBe("0.3.260");
});

// A turn just died on a floor upstream raised minutes ago; a held answer could predate the version that clears it.
test("a floor always asks the registry afresh", async () => {
    const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "2.0.0" }, versions: { "2.0.0": {} } }))
        .mockResolvedValueOnce(jsonResponse({ "dist-tags": { latest: "2.2.0" }, versions: { "2.0.0": {}, "2.2.0": {} } }));
    stubGlobal("fetch", fetchMock);
    expect(await targetVersion("opencode", { kind: "latest" }, CLEAN)).toBe("2.0.0");
    expect(await lowestSatisfying("opencode", "2.2.0")).toBe("2.2.0");
});

test("a version already refused here is not offered again", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(jsonResponse({ engines: { claude: { blessed: "0.3.257" } } })));
    const refused: EngineState = { quarantined: [{ version: "0.3.257", reason: "would not launch", at: "2026-09-01T00:00:00.000Z" }] };
    expect(await targetVersion("claude", { kind: "blessed" }, refused)).toBeUndefined();
});

// Claude Code ships sdk 0.3.N as CLI version 2.1.N, so a floor of 2.1.251 maps to npm version 0.3.251, not a numeric
// comparison against 2.1.251.
test("a CLI-versioned floor selects the lowest npm version that ships it", async () => {
    stubGlobal(
        "fetch",
        jest
            .fn()
            .mockResolvedValue(
                jsonResponse({ "dist-tags": { latest: "0.3.260" }, versions: { "0.3.233": {}, "0.3.251": {}, "0.3.257": {}, "0.3.260": {} } }),
            ),
    );
    expect(await lowestSatisfying("claude", "2.1.251")).toBe("0.3.251");
});

test("a floor stated in the package's own numbers still compares normally", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(jsonResponse({ versions: { "0.3.233": {}, "0.3.251": {}, "0.3.257": {} } })));
    expect(await lowestSatisfying("claude", "0.3.251")).toBe("0.3.251");
});

test("the smallest step is taken, not the newest release", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(jsonResponse({ versions: { "2.0.0": {}, "2.2.0": {}, "2.5.0": {} } })));
    expect(await lowestSatisfying("opencode", "2.2.0")).toBe("2.2.0");
});

// Released daemons drive OpenCode 1 and read the list's `opencode` key; this build reads `opencode-v2`, so neither ever
// sees the other's version.
test("an engine whose major moved reads its blessed version under its own key", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(jsonResponse({ engines: { opencode: { blessed: "1.18.35" }, "opencode-v2": { blessed: "2.0.26" } } })));
    expect(await targetVersion("opencode", { kind: "blessed" }, CLEAN)).toBe("2.0.26");
});

test("a pin to a major this daemon cannot drive offers nothing to install", async () => {
    stubGlobal("fetch", jest.fn());
    expect(await targetVersion("opencode", { kind: "pinned", version: "1.18.35" }, CLEAN)).toBeUndefined();
});

test("a floor is never met by a major this daemon cannot drive", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(jsonResponse({ versions: { "1.18.35": {}, "2.0.26": {} } })));
    expect(await lowestSatisfying("opencode", "1.18.0")).toBe("2.0.26");
});

test("a failed refresh keeps the last list that was read", async () => {
    const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ engines: { claude: { blessed: "0.3.257" } } }, { etag: `"abc"` }))
        .mockRejectedValueOnce(new Error("offline"));
    stubGlobal("fetch", fetchMock);

    expect((await blessedList())?.entries.claude?.blessed).toBe("0.3.257");
    expect((await blessedList(true))?.entries.claude?.blessed).toBe("0.3.257");
});

test("an unreachable list is not a version, and says so by having no read time", async () => {
    stubGlobal("fetch", jest.fn().mockRejectedValue(new Error("offline")));
    expect(await blessedList()).toBeUndefined();
    expect(blessedListReadAt()).toBeUndefined();
    expect(await targetVersion("claude", { kind: "blessed" }, CLEAN)).toBeUndefined();
});

test("a re-read is conditional on the etag it already holds", async () => {
    const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({ engines: { claude: { blessed: "0.3.257" } } }, { etag: `"abc"` }))
        .mockResolvedValueOnce(new Response(undefined, { status: 304 }));
    stubGlobal("fetch", fetchMock);

    await blessedList();
    await blessedList(true);

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { "if-none-match": `"abc"` } });
    expect((await blessedList())?.entries.claude?.blessed).toBe("0.3.257");
});

// A list that fails to parse reads as absent, not as a version to run.
test("a list that does not parse is ignored", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(jsonResponse({ engines: { claude: { blessed: 257 } } })));
    expect(await blessedList()).toBeUndefined();
});

// A release engine's download is held to the hash recorded beside its blessed version, for the build this machine runs.
const HERE = "a".repeat(64);
const THERE = "b".repeat(64);
const translatorList = (entry: Record<string, unknown>): Response => jsonResponse({ engines: { claude: { blessed: "0.3.257" }, translator: entry } });

test("the hash recorded for a blessed release is this machine's build's", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(translatorList({ blessed: "8.1.3", sha256: { [releaseArch()]: HERE, elsewhere: THERE } })));
    expect(await recordedSha256("translator", "8.1.3")).toBe(HERE);
});

// A `latest` or `pinned` channel may name another version; the hash beside 8.1.3 is no statement about its bytes.
test("a hash applies only to the version it was recorded beside", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(translatorList({ blessed: "8.1.3", sha256: { [releaseArch()]: HERE } })));
    expect(await recordedSha256("translator", "8.1.2")).toBeUndefined();
    expect(await recordedSha256("translator", "8.1.4")).toBeUndefined();
});

test("a blessed release with no hash recorded for this machine has none to check against", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(translatorList({ blessed: "8.1.3" })));
    expect(await recordedSha256("translator", "8.1.3")).toBeUndefined();
    stubGlobal("fetch", jest.fn().mockResolvedValue(translatorList({ blessed: "8.1.3", sha256: { elsewhere: THERE } })));
    forgetUpstream();
    expect(await recordedSha256("translator", "8.1.3")).toBeUndefined();
});

test("an engine that publishes no release asks the list for no hash", async () => {
    stubGlobal("fetch", jest.fn());
    expect(await recordedSha256("claude", "0.3.257")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
});

// Every engine is read from the one list, so a hash field that does not parse costs that hash, never the list.
test("a malformed hash record leaves the list, and the version it blesses, readable", async () => {
    stubGlobal("fetch", jest.fn().mockResolvedValue(translatorList({ blessed: "8.1.3", sha256: "not a record" })));
    expect(await targetVersion("translator", { kind: "blessed" }, CLEAN)).toBe("8.1.3");
    expect(await targetVersion("claude", { kind: "blessed" }, CLEAN)).toBe("0.3.257");
    expect(await recordedSha256("translator", "8.1.3")).toBeUndefined();
});
