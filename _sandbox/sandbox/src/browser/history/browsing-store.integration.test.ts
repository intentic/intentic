import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowsingProblem, browsingHistoryDocument, browsingStore, type BrowsingStoreDeps } from "./browsing-store.js";
import type { ChromiumHistory } from "./chromium-history.js";

// The store over a real temp workspace: saved files, loaded back by a second store as a restarted daemon would.

const NOW = 1_790_000_000_000;

let root: string;
let dir: string;
const problems: string[] = [];

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "browsing-store-test-"));
    dir = join(root, browsingHistoryDocument.path);
    problems.length = 0;
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const ROUTER: ChromiumHistory = {
    pages: [{ url: "http://192.168.0.168/", title: "FRITZ!Box", visits: 4, typed: 4, last: NOW - 1000, recent: [{ at: NOW - 1000, typed: true }] }],
    terms: [{ term: "fritzbox login", last: NOW - 2000 }],
};

const storeWith = (chromiumHistory: BrowsingStoreDeps["chromiumHistory"]) =>
    browsingStore({
        root,
        chromiumHistory,
        warn: (problem: BrowsingProblem, message: string) => problems.push(`${message}: ${problem.profile}`),
        now: () => NOW,
        saveDelayMs: 5,
    });

test("a profile is seeded from Chromium's record once, and what it learns after survives a restart", async () => {
    const seeds: string[] = [];
    const seeded = async (profile: string): Promise<ChromiumHistory> => {
        seeds.push(profile);
        return ROUTER;
    };
    const store = storeWith(seeded);
    store.visit("_own", "https://example.com/", "typed", "Example");
    await store.flush();
    // The visit waits for the load, which seeds first.
    const first = await store.read("_own", undefined);
    expect(first.entries.map((entry) => entry.url).toSorted()).toEqual(["http://192.168.0.168/", "https://example.com/"]);
    expect(first.profiles).toEqual(["_own"]);

    const restarted = storeWith(seeded);
    const again = await restarted.read("_own", undefined);
    expect(again.entries).toEqual(first.entries);
    expect(again.terms).toEqual([{ term: "fritzbox login", count: 1, last: NOW - 2000 }]);
    expect(seeds).toEqual(["_own"]);
});

test("profiles never mix: an agent's browser keeps a history of its own", async () => {
    const store = storeWith(async () => undefined);
    store.visit("web", "https://agent.example/", "link");
    store.visit("_own", "https://mine.example/", "link");
    await store.flush();
    expect((await store.read("_own", undefined)).entries.map((entry) => entry.url)).toEqual(["https://mine.example/"]);
    const agents = await store.read("web", undefined);
    expect(agents.entries.map((entry) => entry.url)).toEqual(["https://agent.example/"]);
    expect(agents.profiles).toEqual(["_own", "web"]);
    // One file each, named so an account id with a dot in it is still a file of its own.
    store.visit("acme.dev", "https://acme.example/", "link");
    await store.flush();
    await store.read("acme.dev", undefined);
    expect((await readdir(dir)).toSorted()).toEqual(["p-_own.json", "p-acme_dev.json", "p-web.json"]);
    const saved: unknown = JSON.parse(await readFile(join(dir, "p-acme_dev.json"), "utf8"));
    expect(saved).toMatchObject({ profile: "acme.dev" });
});

test("a forget is on disk when it answers", async () => {
    const store = storeWith(async () => ROUTER);
    expect(await store.forget("_own", { kind: "urls", urls: ["http://192.168.0.168/"] })).toBe(1);
    const restarted = storeWith(async () => ROUTER);
    expect((await restarted.read("_own", undefined)).entries).toEqual([]);
});

test("a seed that fails is tried again on the next start, rather than taken as done", async () => {
    let attempts = 0;
    const flaky = async (): Promise<ChromiumHistory> => {
        attempts += 1;
        if (attempts === 1) {
            throw new Error("database disk image is malformed");
        }
        return ROUTER;
    };
    expect((await storeWith(flaky).read("_own", undefined)).entries).toEqual([]);
    expect(problems).toEqual(["browsing history: could not read Chromium's own history: _own"]);
    expect((await storeWith(flaky).read("_own", undefined)).entries.map((entry) => entry.url)).toEqual(["http://192.168.0.168/"]);
});

test("a file this build cannot read is set aside, and the profile starts over", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "p-_own.json"), JSON.stringify({ profile: "_own", seeded: "yes" }));
    const store = storeWith(async () => undefined);
    expect((await store.read("_own", undefined)).entries).toEqual([]);
    expect(problems).toEqual(["browsing history: unreadable, starting over: _own"]);
    expect((await readdir(dir)).toSorted()).toEqual(["p-_own.json", "p-_own.json.corrupt"]);
});
