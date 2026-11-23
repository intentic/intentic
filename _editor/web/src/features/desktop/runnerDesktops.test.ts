// The desktops the Browsers view offers: this sandbox's, dialled on its own route, and each runner's, dialled through a
// fresh `runners.openView` asked through a conversation on that runner; what the launcher lists; and the rail tile's sum.
import "@intentic/testing/dom";
import type { RunnerOpenViewInput } from "@intentic/sandbox-contract/schemas/runner-views";
import type { SystemDesktop } from "@intentic/sandbox-contract/schemas/terminal";
import { desktopsSummary } from "./desktopQuery";
import { deskEntries, deskWindowOf, desktopSocketUrl, desktopStateOf, type DesktopSocketSeams } from "./runnerDesktops";

const seams = () => {
    const calls: string[] = [];
    const asked: RunnerOpenViewInput[] = [];
    const fake: DesktopSocketSeams = {
        local: async (path, extra) => {
            calls.push(`${path} ${JSON.stringify(extra ?? {})}`);
            return `wss://sbx${path}`;
        },
        runnerUrl: async (input) => {
            asked.push(input);
            return `wss://sbx/system/runner-view/rog/system/desktop-view`;
        },
        conversationOn: (runner) => (runner === `rog` ? `conv-1` : undefined),
    };
    return { fake, calls, asked };
};

it("dials this sandbox's own desktop, or one window on it, on its own route", async () => {
    const { fake, calls, asked } = seams();
    await desktopSocketUrl({}, fake);
    await desktopSocketUrl({ window: `0x1a` }, fake);
    expect(calls).toEqual([`/system/desktop-view {}`, `/system/desktop-view {"window":"0x1a"}`]);
    expect(asked).toEqual([]);
});

it("dials a runner's desktop through a conversation on it, the window as the view's session", async () => {
    const { fake, calls, asked } = seams();
    await expect(desktopSocketUrl({ runner: `rog` }, fake)).resolves.toBe(`wss://sbx/system/runner-view/rog/system/desktop-view`);
    await desktopSocketUrl({ runner: `rog`, window: `0x2b` }, fake);
    await expect(desktopSocketUrl({ runner: `z440` }, fake)).resolves.toBeUndefined();
    expect(asked).toEqual([
        { conversationId: `conv-1`, kind: `desktop-view` },
        { conversationId: `conv-1`, kind: `desktop-view`, session: `0x2b` },
    ]);
    expect(calls).toEqual([]);
});

const STATE: SystemDesktop = {
    running: true,
    display: `:99`,
    windows: 1,
    list: [{ id: `0x1`, title: `Game`, app: `godot`, focused: true }],
    runners: [{ runner: `rog`, state: { running: true, display: `:1`, windows: 2, list: [{ id: `0x2`, title: ``, app: `Blender`, focused: false }, { id: `0x3`, title: `Doc`, app: `soffice`, focused: true }] } }],
};

it("reads a runner's desktop and its windows apart from this sandbox's", () => {
    expect(desktopStateOf(STATE, `rog`)?.display).toBe(`:1`);
    expect(desktopStateOf(STATE, undefined)?.display).toBe(`:99`);
    expect(desktopStateOf(STATE, `z440`)).toBeUndefined();
    expect([deskWindowOf(STATE, `0x2`, `rog`)?.app, deskWindowOf(STATE, `0x2`)?.app, deskWindowOf(STATE, `0x1`)?.app]).toEqual([`Blender`, undefined, `godot`]);
});

it("offers each desktop and the windows on it, this sandbox's first", () => {
    const entries = deskEntries(STATE, (runner) => (runner === undefined ? `Desktop` : `Desktop on ${runner}`));
    expect(entries.map(({ tab, label, detail }) => ({ tab, label, detail }))).toEqual([
        { tab: { kind: `desktop`, runner: undefined }, label: `Desktop`, detail: `desktop://` },
        { tab: { kind: `app`, id: `0x1`, runner: undefined }, label: `Game`, detail: `app://godot` },
        { tab: { kind: `desktop`, runner: `rog` }, label: `Desktop on rog`, detail: `desktop://rog` },
        { tab: { kind: `app`, id: `0x2`, runner: `rog` }, label: `Blender`, detail: `app://blender` },
        { tab: { kind: `app`, id: `0x3`, runner: `rog` }, label: `Doc`, detail: `app://soffice` },
    ]);
});

it("counts every desktop's windows for the rail, and opens the busiest", () => {
    expect(desktopsSummary(STATE)).toEqual({ windows: 3, tab: `desktop:rog` });
    expect(desktopsSummary({ running: true, windows: 2 })).toEqual({ windows: 2, tab: `desktop` });
    expect(desktopsSummary({ running: false })).toEqual({ windows: undefined, tab: `desktop` });
    expect(desktopsSummary(undefined)).toEqual({ windows: undefined, tab: `desktop` });
});
