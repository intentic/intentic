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

test("the check offers a release only after stable points at its image", async () => {
    const asked: string[] = [];
    stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        if (url.endsWith("/releases/latest")) {return new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 });}
        if (url.includes("/token?")) {return new Response(JSON.stringify({ token: "read-only" }), { status: 200 });}
        return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:published" } });
    });
    await refreshLatestVersion();
    expect(latestVersion()).toBe("9.9.9");
    expect(asked).toEqual([expect.stringContaining("/releases/latest"), expect.stringContaining("/token?"), expect.stringContaining("/manifests/9.9.9"), expect.stringContaining("/manifests/stable")]);
});

// "Update now" restarted onto the image the sandbox already had and still read "update available": a version `ic` cannot
// pull yet is not offered, and the last one it can stays offered meanwhile.
test("a GitHub release ahead of the stable image is not offered, and the published one stays", async () => {
    const release = (tag: string, stable: string) =>
        stubGlobal("fetch", async (url: string) => {
            if (url.endsWith("/releases/latest")) {return new Response(JSON.stringify({ tag_name: tag }), { status: 200 });}
            if (url.includes("/token?")) {return new Response(JSON.stringify({ token: "read-only" }), { status: 200 });}
            const digest = url.endsWith("/stable") ? `sha256:${stable}` : `sha256:${url.slice(url.lastIndexOf("/") + 1)}`;
            return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
        });
    release("v9.9.9", "9.9.9");
    await refreshLatestVersion();
    expect(latestVersion()).toBe("9.9.9");
    release("v9.9.10", "9.9.9");
    await refreshLatestVersion();
    expect(latestVersion()).toBe("9.9.9");
    release("v9.9.10", "9.9.10");
    await refreshLatestVersion();
    expect(latestVersion()).toBe("9.9.10");
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
    stubGlobal("fetch", async (url: string) => {
        if (url.endsWith("/releases/latest")) {return new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 });}
        if (url.includes("/token?")) {return new Response(JSON.stringify({ token: "read-only" }), { status: 200 });}
        return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:published" } });
    });
    await refreshLatestVersion();
    stubGlobal("fetch", async () => {
        throw new Error("offline");
    });
    await refreshLatestVersion();
    expect(latestVersion()).toBe("9.9.9"); // not clobbered by the failure
});
