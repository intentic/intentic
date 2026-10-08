import type { BrowserSession } from "@intentic/sandbox-contract";
import { browsersChip, desktopChip, portsChip, previewChip, terminalChip, vpnChip } from "./runtimeChips";

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

describe(`the live app's chip`, () => {
    it(`shows only while something answers, or while its page is in front`, () => {
        expect(previewChip({ healthy: 0, here: false, label: `Live app` })).toBeUndefined();
        expect(previewChip({ healthy: 2, here: false, label: `Live app` })).toMatchObject({ to: `/preview`, count: 2, active: false });
        expect(previewChip({ healthy: 0, here: true, label: `See it` })).toMatchObject({ label: `See it`, active: true });
        expect(previewChip({ healthy: 0, here: true, label: `See it` })?.count).toBeUndefined();
    });
});

describe(`the browsers' chip`, () => {
    it(`ignores browsers that have closed: the daemon's record of them is the Browsers page's`, () => {
        expect(browsersChip({ sessions: [], here: false })).toBeUndefined();
        expect(browsersChip({ sessions: [browser({ running: false, finishedAt: 2 })], here: false })).toBeUndefined();
        expect(browsersChip({ sessions: [browser({ running: false, finishedAt: 2 })], here: true })).toMatchObject({ active: true });
        expect(browsersChip({ sessions: [browser(), browser({ name: `b2` }), browser({ name: `b3`, running: false })], here: false })).toMatchObject({
            count: 2,
            to: `/browsers`,
        });
    });

    it(`turns to a warning, counting what waits, while an agent asks for help in one`, () => {
        const help = { requestId: `r1`, message: `captcha`, requestedAt: 1 };
        const chip = browsersChip({ sessions: [browser({ help }), browser({ name: `b2` })], here: false });
        expect(chip).toMatchObject({ count: 1, tone: `warning` });
        expect(chip?.aria).toBe(`Browsers, Needs your help`);
    });
});

describe(`the desktop's chip`, () => {
    it(`shows while a window is open on it, or while its page is in front`, () => {
        expect(desktopChip({ windows: 0, here: false })).toBeUndefined();
        expect(desktopChip({ windows: 3, here: false })).toMatchObject({ to: `/desktop`, count: 3 });
        expect(desktopChip({ windows: 0, here: true })).toMatchObject({ active: true });
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
