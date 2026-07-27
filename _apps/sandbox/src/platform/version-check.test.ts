import { afterEach, expect, test, vi } from "vitest";
import { isDevBuild } from "../version.js";
import { isNewer, latestVersion, refreshLatestVersion, startVersionCheck } from "./version-check.js";

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

test("a dev build never checks, so /info can't offer an update that would move it backwards", async () => {
    let fetched = false;
    vi.stubGlobal("fetch", async () => {
        fetched = true;
        return new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 });
    });
    // The repo's own package.json carries the unstamped sentinel, so a test run IS a dev build.
    expect(isDevBuild).toBe(true);
    startVersionCheck().stop();
    await Promise.resolve();
    expect(fetched).toBe(false);
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
