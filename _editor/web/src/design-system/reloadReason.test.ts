// jsdom: the gate every reload the app starts itself goes through (reloadReason.ts). On 2026-10-27 one cached 404
// reloaded /sandbox about once a second for minutes; these pin the ceiling that ends any such loop at a few reloads,
// whichever path starts it, and the page-leaving signal that keeps a leaving page from blaming its sandbox.
import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import type { AutomaticReload } from "@intentic/ui/reload-reason";

type Gate = typeof import("@intentic/ui/reload-reason");
// A fresh module is a fresh page: the watcher and the leaving state are this page's, the count rides in session storage.
const load = (): Promise<Gate> => freshImport<Gate>(`../../../ui/src/lib/reloadReason.ts`, import.meta.url);

const T0 = 1_000_000;
const heardFrom = (gate: Gate): AutomaticReload[] => {
    const heard: AutomaticReload[] = [];
    gate.watchAutomaticReloads((reload) => heard.push(reload));
    return heard;
};

beforeEach(() => {
    sessionStorage.clear();
    jest.restoreAllMocks();
});

it(`lets a tab reload itself three times a minute across its loads, then refuses the next and says why`, async () => {
    const now = jest.spyOn(Date, `now`).mockReturnValue(T0);
    expect((await load()).noteReload(`stale-chunk`, { target: `/sandbox` })).toBe(true);
    expect((await load()).noteReload(`self-heal`)).toBe(true);
    expect((await load()).noteReload(`stale-chunk`)).toBe(true);
    const fourth = await load();
    const heard = heardFrom(fourth);
    expect(fourth.noteReload(`stale-chunk`, { target: `/sandbox` })).toBe(false);
    expect(heard).toEqual([{ reason: `stale-chunk`, allowed: false, inLastMinute: 3, details: { target: `/sandbox` } }]);
    // A minute on, the tab may repair itself again.
    now.mockReturnValue(T0 + 61_000);
    expect((await load()).noteReload(`stale-chunk`)).toBe(true);
});

it(`tells the watcher of each one it lets through, with how many this minute`, async () => {
    jest.spyOn(Date, `now`).mockReturnValue(T0);
    const gate = await load();
    const heard = heardFrom(gate);
    gate.noteReload(`stale-chunk`, { target: `/sandbox`, refused: `https://app.example/assets/a-1.js` });
    gate.noteReload(`opener-fallback`, { path: `/setup` });
    expect(heard).toEqual([
        { reason: `stale-chunk`, allowed: true, inLastMinute: 1, details: { target: `/sandbox`, refused: `https://app.example/assets/a-1.js` } },
        { reason: `opener-fallback`, allowed: true, inLastMinute: 2, details: { path: `/setup` } },
    ]);
});

it(`never refuses or counts a reload the reader pressed for: an update, signing in or out`, async () => {
    jest.spyOn(Date, `now`).mockReturnValue(T0);
    const gate = await load();
    const heard = heardFrom(gate);
    expect([gate.noteReload(`stale-chunk`), gate.noteReload(`stale-chunk`), gate.noteReload(`stale-chunk`)]).toEqual([true, true, true]);
    expect([gate.noteReload(`update`), gate.noteReload(`sign-in`), gate.noteReload(`sign-out`)]).toEqual([true, true, true]);
    expect(heard.map((reload) => reload.reason)).toEqual([`stale-chunk`, `stale-chunk`, `stale-chunk`]);
    expect(gate.takeReloadReason()).toBe(`sign-out`);
});

it(`refuses a reload nobody pressed for when the tab cannot remember it, since then nothing could bound them`, async () => {
    const gate = await load();
    const heard = heardFrom(gate);
    jest.spyOn(Storage.prototype, `setItem`).mockImplementation(() => {
        throw new Error(`QuotaExceededError`);
    });
    expect(gate.noteReload(`self-heal`)).toBe(false);
    expect(heard[0]).toMatchObject({ reason: `self-heal`, allowed: false, details: { storage: `unavailable` } });
    expect(gate.noteReload(`update`)).toBe(true);
});

it(`says the page is leaving once its own reload goes ahead, for a few seconds, and not after a refused one`, async () => {
    const now = jest.spyOn(Date, `now`).mockReturnValue(T0);
    const gate = await load();
    expect(gate.pageLeaving()).toBe(false);
    gate.noteReload(`update`);
    expect(gate.pageLeaving()).toBe(true);
    // Still here long after: the navigation was taken over (a desktop link), and the page is not leaving after all.
    now.mockReturnValue(T0 + 11_000);
    expect(gate.pageLeaving()).toBe(false);

    sessionStorage.setItem(`intentic.automaticReloads`, [T0, T0, T0].join(`,`));
    now.mockReturnValue(T0 + 1_000);
    const spent = await load();
    expect(spent.noteReload(`stale-chunk`)).toBe(false);
    expect(spent.pageLeaving()).toBe(false);
});

it(`follows the page being hidden on its way out, and its return from the back-forward cache`, async () => {
    const gate = await load();
    const page = new EventTarget();
    // SAFETY: watchPageLeaving only adds listeners, which any EventTarget takes.
    gate.watchPageLeaving(page as Window);
    page.dispatchEvent(new Event(`pagehide`));
    expect(gate.pageLeaving()).toBe(true);
    page.dispatchEvent(new Event(`pageshow`));
    expect(gate.pageLeaving()).toBe(false);
});
