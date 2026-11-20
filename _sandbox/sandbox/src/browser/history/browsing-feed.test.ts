import { unstubbed } from "@intentic/testing";
import { noteBrowsing, type NavigationHistoryReader, startBrowsingFeed } from "./browsing-feed.js";
import type { BrowsingStore } from "./browsing-store.js";

// What the daemon's re-reads of a tab become: a visit when its address moved, typed or followed as Chromium's own
// history list says, and a title for the page it is already on otherwise.

const said: string[] = [];
const store = unstubbed<BrowsingStore>("store", {
    visit: (profile, url, kind, title) => void said.push(`visit ${profile} ${url} ${kind} ${title ?? "-"}`),
    retitle: (profile, url, title) => void said.push(`retitle ${profile} ${url} ${title}`),
});

const chromium = (transitionType: string): NavigationHistoryReader => ({
    send: async () => ({ currentIndex: 1, entries: [{ transitionType: "link" }, { transitionType }] }),
});

// The transition is read asynchronously; a turn of the microtask queue lets it land.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    said.length = 0;
    startBrowsingFeed(store);
});

afterAll(() => startBrowsingFeed(undefined));

test("a tab arriving somewhere is a visit of its window's profile; the same address again is only its title", async () => {
    const tab = { url: "http://192.168.0.168/", title: undefined, cdp: chromium("typed") };
    noteBrowsing("_own", tab);
    await settle();
    // Re-read with nothing new: nothing to say.
    noteBrowsing("_own", tab);
    // The same tab record, its title read since (browser-sessions.ts mutates it in place).
    noteBrowsing("_own", Object.assign(tab, { title: "FRITZ!Box" }));
    await settle();
    expect(said).toEqual(["visit _own http://192.168.0.168/ typed -", "retitle _own http://192.168.0.168/ FRITZ!Box"]);
});

test("Chromium's transition says typed, followed or reloaded; a tab it cannot be asked about counts as followed", async () => {
    noteBrowsing("web", { url: "https://a.example/", title: "A", cdp: chromium("address_bar") });
    noteBrowsing("web", { url: "https://b.example/", title: "B", cdp: chromium("form_submit") });
    noteBrowsing("web", { url: "https://c.example/", title: "C", cdp: chromium("reload") });
    noteBrowsing("web", { url: "https://d.example/", title: "D", cdp: undefined });
    const failing: NavigationHistoryReader = { send: () => Promise.reject(new Error("Target closed")) };
    noteBrowsing("web", { url: "https://e.example/", title: "E", cdp: failing });
    await settle();
    expect(said.toSorted()).toEqual([
        "visit web https://a.example/ typed A",
        "visit web https://b.example/ link B",
        "visit web https://c.example/ reload C",
        "visit web https://d.example/ link D",
        "visit web https://e.example/ link E",
    ]);
});

test("with no store started, a tab's changes go nowhere", async () => {
    startBrowsingFeed(undefined);
    noteBrowsing("_own", { url: "https://a.example/", title: "A", cdp: undefined });
    await settle();
    expect(said).toEqual([]);
});
