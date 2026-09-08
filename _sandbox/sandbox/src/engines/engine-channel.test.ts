import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { blessedList, blessedListReadAt, forgetBlessedList, lowestSatisfying, targetVersion } from "./engine-channel.js";
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

test("a version already refused here is not offered again", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { claude: { blessed: "0.3.257" } } })));
    const refused: EngineState = { quarantined: [{ version: "0.3.257", reason: "would not launch", at: "2026-09-01T00:00:00.000Z" }] };
    expect(await targetVersion("claude", { kind: "blessed" }, refused)).toBeUndefined();
});

// Claude Code ships sdk 0.3.N as CLI version 2.1.N, so a floor of 2.1.251 maps to npm version 0.3.251, not a numeric
// comparison against 2.1.251.
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

// A list that fails to parse reads as absent, not as a version to run.
test("a list that does not parse is ignored", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ engines: { claude: { blessed: 257 } } })));
    expect(await blessedList()).toBeUndefined();
});
