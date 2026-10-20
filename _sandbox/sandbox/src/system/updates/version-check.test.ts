import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { isDevBuild } from "../../version.js";
import { expireTimeouts, stalledFetch } from "../../http/fetch.testing.js";
import {
    CHASE_DELAYS_MS,
    isNewer,
    latestVersion,
    noticeSeenVersions,
    onLatestVersion,
    RELEASE_FETCH_TIMEOUT_MS,
    refreshLatestVersion,
    startVersionCheck,
} from "./version-check.js";

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

test("a GitHub that never answers times the refresh out and keeps the version it had", async () => {
    stubGlobal("fetch", async (url: string) => {
        if (url.endsWith("/releases/latest")) {return new Response(JSON.stringify({ tag_name: "v8.8.8" }), { status: 200 });}
        if (url.includes("/token?")) {return new Response(JSON.stringify({ token: "read-only" }), { status: 200 });}
        return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:published" } });
    });
    await refreshLatestVersion();
    expect(latestVersion()).toBe("8.8.8");
    stubGlobal("fetch", stalledFetch);
    const timeouts = expireTimeouts();
    try {
        await refreshLatestVersion();
        expect(timeouts.asked).toEqual([RELEASE_FETCH_TIMEOUT_MS]);
    } finally {
        timeouts.mockRestore();
    }
    expect(latestVersion()).toBe("8.8.8");
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

// GitHub's latest release and what `:stable` names, as the registry would answer for them.
const releaseOut = (tag: string, stable: string, asked: string[] = []) =>
    stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        if (url.endsWith("/releases/latest")) {return new Response(JSON.stringify({ tag_name: tag }), { status: 200 });}
        if (url.includes("/token?")) {return new Response(JSON.stringify({ token: "read-only" }), { status: 200 });}
        const digest = url.endsWith("/stable") ? `sha256:${stable}` : `sha256:${url.slice(url.lastIndexOf("/") + 1)}`;
        return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
    });

// A wait that runs at once, recording the delay each look asked for.
const immediateTimers = () => {
    const delays: number[] = [];
    const wait = (run: () => void, ms: number): (() => void) => {
        delays.push(ms);
        const timer = setTimeout(run, 0);
        return () => clearTimeout(timer);
    };
    return { delays, wait };
};

const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
};

// The desktop installer read 1.345.0 while the sandbox beside it read "up to date" for most of an hour: a computer
// dialling in on a newer release is proof one is out, and is looked for now.
test("a computer on a newer release than any known starts a look at once, and the update card hears of it", async () => {
    releaseOut("v20.0.0", "20.0.0");
    await refreshLatestVersion();
    const heard: string[] = [];
    const stop = onLatestVersion((version) => heard.push(version));
    const timers = immediateTimers();
    try {
        releaseOut("v20.0.1", "20.0.1");
        noticeSeenVersions(["19.0.0", "20.0.1"], "20.0.0", timers.wait);
        await settle();
    } finally {
        stop();
    }
    expect(latestVersion()).toBe("20.0.1");
    expect(heard).toEqual(["20.0.1"]);
    expect(timers.delays).toEqual([0]);
});

test("a computer on a release already known, or older than this sandbox, asks nothing", async () => {
    const asked: string[] = [];
    releaseOut("v20.0.1", "20.0.1", asked);
    await refreshLatestVersion();
    asked.length = 0;
    const timers = immediateTimers();
    noticeSeenVersions(["20.0.1", "1.0.0", "0.0.0", "not-a-version"], "20.0.0", timers.wait);
    noticeSeenVersions(["20.0.5"], "20.0.5", timers.wait);
    await settle();
    expect(asked).toEqual([]);
});

test("a release the computer has before `:stable` does is looked for again on a backoff, then left to the hourly check", async () => {
    releaseOut("v21.0.0", "20.0.1");
    await refreshLatestVersion();
    expect(latestVersion()).toBe("20.0.1");
    const timers = immediateTimers();
    noticeSeenVersions(["21.0.0"], "20.0.1", timers.wait);
    await settle();
    expect(timers.delays).toEqual([...CHASE_DELAYS_MS]);
    expect(latestVersion()).toBe("20.0.1");
});

test("the backoff stops as soon as the release reaches `:stable`", async () => {
    // Published on `:stable` from the second look on.
    let looks = 0;
    stubGlobal("fetch", async (url: string) => {
        if (url.endsWith("/releases/latest")) {
            looks += 1;
            return new Response(JSON.stringify({ tag_name: "v23.0.0" }), { status: 200 });
        }
        if (url.includes("/token?")) {return new Response(JSON.stringify({ token: "read-only" }), { status: 200 });}
        const published = looks >= 2 ? "23.0.0" : "20.0.1";
        const digest = url.endsWith("/stable") ? `sha256:${published}` : `sha256:${url.slice(url.lastIndexOf("/") + 1)}`;
        return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
    });
    const timers = immediateTimers();
    noticeSeenVersions(["23.0.0"], "20.0.1", timers.wait);
    await settle();
    expect(looks).toBe(2);
    expect(timers.delays).toEqual([CHASE_DELAYS_MS[0], CHASE_DELAYS_MS[1]]);
    expect(latestVersion()).toBe("23.0.0");
});
