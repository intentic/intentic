import { afterEach, expect, test, vi } from "vitest";
import { isNewer, latestVersion, refreshLatestVersion } from "./version-check.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

test("isNewer compares dotted numeric versions", () => {
    expect(isNewer("1.3.0", "1.2.9")).toBe(true); // newer minor
    expect(isNewer("1.2.10", "1.2.9")).toBe(true); // numeric, not lexical
    expect(isNewer("2.0.0", "1.9.9")).toBe(true); // newer major
    expect(isNewer("1.2.3", "1.2.3")).toBe(false); // equal
    expect(isNewer("1.2.2", "1.2.3")).toBe(false); // older
    expect(isNewer("1.2", "1.2.0")).toBe(false); // missing segment treated as 0
});

test("refreshLatestVersion populates the cache from the npm packument version", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }));
    await refreshLatestVersion();
    expect(latestVersion()).toBe("9.9.9");
});

test("a failed refresh keeps the previous cached value", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }));
    await refreshLatestVersion();
    vi.stubGlobal("fetch", async () => {
        throw new Error("offline");
    });
    await refreshLatestVersion();
    expect(latestVersion()).toBe("9.9.9"); // not clobbered by the failure
});
