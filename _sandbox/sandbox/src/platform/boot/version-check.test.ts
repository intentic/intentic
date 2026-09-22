import { test, expect, afterEach } from "bun:test";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { isDevBuild } from "../../version.js";
import { isNewer, latestVersion, refreshLatestVersion, startVersionCheck } from "./version-check.js";

afterEach(() => {
    unstubAllGlobals();
});

test("isNewer compares dotted numeric versions", () => {
    expect(isNewer("1.3.0", "1.2.9")).toBe(true); // newer minor
    expect(isNewer("1.2.10", "1.2.9")).toBe(true); // numeric, not lexical
    expect(isNewer("2.0.0", "1.9.9")).toBe(true); // newer major
    expect(isNewer("1.2.3", "1.2.3")).toBe(false); // equal
    expect(isNewer("1.2.2", "1.2.3")).toBe(false); // older
    expect(isNewer("1.2", "1.2.0")).toBe(false); // missing segment treated as 0
});

// One lane: a release is stable the moment it publishes, so there is one pointer to read and no channel that
// reads a different one.
test("the check reads the released pointer, /releases/latest", async () => {
    const asked: string[] = [];
    stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 });
    });
    await refreshLatestVersion();
    expect(latestVersion()).toBe("9.9.9");
    expect(asked).toEqual([expect.stringContaining("/releases/latest")]);
});

test("a dev build never checks, so /info can't offer an update that would move it backwards", async () => {
    let fetched = false;
    stubGlobal("fetch", async () => {
        fetched = true;
        return new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 });
    });
    // The repo's own package.json carries the unstamped sentinel, so a test run IS a dev build.
    expect(isDevBuild).toBe(true);
    startVersionCheck().stop();
    await Promise.resolve();
    expect(fetched).toBe(false);
});

test("a failed refresh keeps the previous cached value", async () => {
    stubGlobal("fetch", async () => new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 }));
    await refreshLatestVersion();
    stubGlobal("fetch", async () => {
        throw new Error("offline");
    });
    await refreshLatestVersion();
    expect(latestVersion()).toBe("9.9.9"); // not clobbered by the failure
});
