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

test("a stable channel reads the promoted release — the one behind /releases/latest", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 });
    });
    await refreshLatestVersion("stable");
    expect(latestVersion()).toBe("9.9.9");
    expect(asked[0]).toContain("/releases/latest");
    // The pre-channel empty string and the core profile are stable-family too.
    await refreshLatestVersion("");
    await refreshLatestVersion("core-stable");
    expect(asked.every((url) => url.includes("/releases/latest"))).toBe(true);
});

test("a beta channel reads the newest release, promoted or not", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify([{ tag_name: "v9.9.10" }]), { status: 200 });
    });
    await refreshLatestVersion("beta");
    expect(latestVersion()).toBe("9.9.10");
    await refreshLatestVersion("core-beta");
    expect(asked.every((url) => url.includes("per_page=1"))).toBe(true);
});

test("a dev build never checks, so /info can't offer an update that would move it backwards", async () => {
    let fetched = false;
    vi.stubGlobal("fetch", async () => {
        fetched = true;
        return new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 });
    });
    // The repo's own package.json carries the unstamped sentinel, so a test run IS a dev build.
    expect(isDevBuild).toBe(true);
    startVersionCheck("stable").stop();
    await Promise.resolve();
    expect(fetched).toBe(false);
});

test("a failed refresh keeps the previous cached value", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 }));
    await refreshLatestVersion("stable");
    vi.stubGlobal("fetch", async () => {
        throw new Error("offline");
    });
    await refreshLatestVersion("stable");
    expect(latestVersion()).toBe("9.9.9"); // not clobbered by the failure
});
