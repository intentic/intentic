import type { BrowserSession } from "@intentic/sandbox-contract";
import { browsersChip, portsChip, terminalChip, vpnChip } from "./runtimeChips";

// The rules that decide when each runtime chip is in the status bar: there while its thing is live or its page is in
// front, gone otherwise, so a chip arriving is news. The terminal alone stays.

const browser = (overrides: Partial<BrowserSession> = {}): BrowserSession => ({
    name: `b1`,
    label: `example.com`,
    server: `web`,
    running: true,
    activityAt: 1,
    pages: [],
    ...overrides,
});

describe(`the terminal's chip`, () => {
    it(`stays with nothing running, and counts live sessions when there are some`, () => {
        const idle = terminalChip({ count: 0, summary: undefined, open: false, keys: `Ctrl+\`` });
        expect([idle.label, idle.count, idle.to, idle.active]).toEqual([`Terminal`, undefined, undefined, false]);
        expect(idle.aria).toBe(`Terminal (Ctrl+\`)`);

        const busy = terminalChip({ count: 2, summary: `2 shells`, open: true, keys: undefined });
        expect([busy.count, busy.active, busy.aria]).toEqual([2, true, `Terminal, 2 shells`]);
    });
});

const facts = (overrides: Partial<Parameters<typeof browsersChip>[0]> = {}): Parameters<typeof browsersChip>[0] => ({
    sessions: [],
    apps: 0,
    desktopWindows: 0,
    appsLabel: `Live app`,
    here: false,
    ...overrides,
});

describe(`the browsers' chip`, () => {
    it(`is one chip for everything the Browsers view shows: live apps, web windows and the desktop`, () => {
        const chip = browsersChip(facts({ apps: 1, sessions: [browser(), browser({ name: `b2` })], desktopWindows: 1 }));
        expect(chip).toMatchObject({ label: `Browsers`, count: 4, to: `/browsers` });
        expect(chip?.tip?.rows).toEqual([
            { label: `Live app`, value: `1 running` },
            { label: `Browsers`, value: `2 open` },
            { label: `Desktop`, value: `1 window open` },
        ]);
    });

    it(`shows only while something is live, or while its page is in front`, () => {
        expect(browsersChip(facts())).toBeUndefined();
        expect(browsersChip(facts({ here: true }))).toMatchObject({ active: true });
        expect(browsersChip(facts({ here: true }))?.count).toBeUndefined();
        // A desktop this reader may not drive is not counted.
        expect(browsersChip(facts({ desktopWindows: undefined }))).toBeUndefined();
    });

    it(`ignores browsers that have closed: the daemon's record of them is the Browsers page's`, () => {
        expect(browsersChip(facts({ sessions: [browser({ running: false, finishedAt: 2 })] }))).toBeUndefined();
        expect(browsersChip(facts({ sessions: [browser({ running: false, finishedAt: 2 })], here: true }))).toMatchObject({ active: true });
    });

    it(`opens the one kind that is live by name, since a bare /browsers reopens whatever tab was in front`, () => {
        expect(browsersChip(facts({ apps: 2 }))).toMatchObject({ to: `/browsers?preview`, count: 2 });
        expect(browsersChip(facts({ desktopWindows: 3 }))).toMatchObject({ to: `/browsers/desktop`, count: 3 });
        expect(browsersChip(facts({ sessions: [browser(), browser({ name: `b2` }), browser({ name: `b3`, running: false })] }))).toMatchObject({
            count: 2,
            to: `/browsers/${browser().name}`,
        });
    });

    it(`turns to a warning, counting what waits, while an agent asks for help in one`, () => {
        const help = { requestId: `r1`, message: `captcha`, requestedAt: 1 };
        const chip = browsersChip(facts({ apps: 1, sessions: [browser({ name: `b2` }), browser({ help })] }));
        expect(chip).toMatchObject({ count: 1, tone: `warning`, to: `/browsers/${browser().name}` });
        expect(chip?.aria).toBe(`Browsers, Needs your help`);
    });
});

describe(`the standing states`, () => {
    it(`warns while a port answers the internet, naming one and counting several`, () => {
        expect(portsChip({ ports: [], here: false })).toBeUndefined();
        expect(portsChip({ ports: [3000], here: false })).toMatchObject({ label: `Port 3000 public`, tone: `warning`, to: `/sandbox/ports` });
        expect(portsChip({ ports: [3000, 5173], here: false })).toMatchObject({ label: `2 ports public`, aria: `Publicly reachable: 3000, 5173` });
    });

    it(`says a tunnel is up while one is`, () => {
        expect(vpnChip({ names: [], here: false })).toBeUndefined();
        expect(vpnChip({ names: [`office`], here: false })).toMatchObject({ label: `VPN`, tone: `success`, aria: `VPN connected: office` });
    });
});
