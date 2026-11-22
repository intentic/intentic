// Where a computer's screen goes besides its full page: one tab per computer beside the section, a window shaped like its
// monitor, and the note that hands it back from that window.
import "@intentic/testing/dom";

const { onScreenHome, openScreenBeside, openScreenWindow, SCREEN_SIDE_VIEW, screenSideInput, screenWindowSize } = await import("./screenPlaces");
const { closeAllTabs, sideDocked, useSidePanel } = await import("../../../../workbench/side/sideTabs");
const { activeSandboxId } = await import("../../../../app/storage/activeSandbox");

const panel = useSidePanel();
const ROG = { machine: `rog`, device: `rog`, name: `rog` };

afterEach(() => {
    closeAllTabs();
    sideDocked.value = false;
});

it("opens a window shaped like the monitor, as large as fits in most of the screen, with the toolbar over it", () => {
    // 80% of 1920×1080 is 1536×864; 864 less the 41 px bar leaves 823 px of 16:9 picture, 1463 px wide.
    expect(screenWindowSize({ width: 3840, height: 2160 }, { width: 1920, height: 1080 })).toEqual({ width: 1463, height: 864 });
    // A portrait monitor is held by the height as well, never wider than its proportions allow.
    expect(screenWindowSize({ width: 1080, height: 1920 }, { width: 1920, height: 1080 })).toEqual({ width: 463, height: 864 });
    // A monitor not known yet opens at a laptop's proportions rather than at nothing.
    expect(screenWindowSize(undefined, { width: 1920, height: 1080 })).toEqual({ width: 1317, height: 864 });
    expect(screenWindowSize({ width: 0, height: 0 }, { width: 1920, height: 1080 })).toEqual({ width: 1317, height: 864 });
});

it("names a screen by its computer and monitor, leaving an unpicked monitor out", () => {
    expect(screenSideInput(ROG)).toEqual({ machine: `rog`, device: `rog`, name: `rog` });
    expect(screenSideInput({ ...ROG, monitor: `1` })).toEqual({ machine: `rog`, device: `rog`, name: `rog`, monitor: `1` });
});

it("keeps one tab per computer beside the section, another monitor taking its place on the strip", () => {
    sideDocked.value = true;
    expect(openScreenBeside(ROG)).toBe(true);
    expect(openScreenBeside({ machine: `marta`, device: `marta`, name: `marta` })).toBe(true);
    expect(openScreenBeside({ ...ROG, monitor: `1` })).toBe(true);
    expect(panel.tabs.value.map((tab) => [tab.view, tab.input[`device`], tab.input[`monitor`]])).toEqual([
        [SCREEN_SIDE_VIEW, `rog`, `1`],
        [SCREEN_SIDE_VIEW, `marta`, undefined],
    ]);
    expect(panel.tabs.value.find((tab) => tab.id === panel.active.value)?.input[`device`]).toBe(`rog`);
});

// The browser's window.open, stood in for while `run` runs: what it was asked, answering `opened`.
const withOpen = (opened: Window | null, run: (asked: unknown[][]) => void): void => {
    const own = Object.getOwnPropertyDescriptor(window, `open`);
    const asked: unknown[][] = [];
    Object.defineProperty(window, `open`, {
        configurable: true,
        value: (...args: unknown[]) => {
            asked.push(args);
            return opened;
        },
    });
    try {
        run(asked);
    } finally {
        if (own !== undefined) {
            Object.defineProperty(window, `open`, own);
        }
    }
};

it("moves a computer into a window of its own, taking its tab from beside the section, and raises that window after", () => {
    sideDocked.value = true;
    activeSandboxId.value = `sb-1`;
    openScreenBeside(ROG);
    openScreenBeside({ machine: `marta`, device: `marta`, name: `marta` });
    const focus = jest.fn();
    // SAFETY: the opener reads only `closed` and `focus` off the window it opened.
    const opened = { closed: false, focus } as unknown as Window;
    withOpen(opened, (asked) => {
        expect(openScreenWindow({ ...ROG, monitor: `1` }, { width: 1920, height: 1080 })).toBe(true);
        expect(asked).toHaveLength(1);
        const [address, name, features] = asked[0] ?? [];
        expect(String(address)).toMatch(/floating\/screen\?sandbox=sb-1&machine=rog&device=rog&name=rog&monitor=1$/u);
        expect(name).toBe(`intentic-screen-rog`);
        expect(String(features)).toContain(`popup=1`);
        expect(panel.tabs.value.map((tab) => tab.input[`device`])).toEqual([`marta`]);
        // Pressed again, the window it has is raised rather than a second one opened.
        expect(openScreenWindow(ROG)).toBe(true);
        expect(asked).toHaveLength(1);
        expect(focus).toHaveBeenCalledTimes(2);
    });
});

it("leaves the screen where it is when the browser refuses the window", () => {
    sideDocked.value = true;
    activeSandboxId.value = `sb-1`;
    const marta = { machine: `marta`, device: `marta`, name: `marta` };
    openScreenBeside(marta);
    withOpen(null, () => {
        expect(openScreenWindow(marta)).toBe(false);
        expect(panel.tabs.value.map((tab) => tab.input[`device`])).toEqual([`marta`]);
    });
});

it("opens nothing beside where the window has no side panel", () => {
    expect(openScreenBeside(ROG)).toBe(false);
    expect(panel.tabs.value).toEqual([]);
});

it("takes a screen handed back from its window only from this app's own origin", () => {
    const shown = jest.fn();
    const stop = onScreenHome(shown);
    const note = { kind: `intentic.screen.home`, at: { ...ROG, monitor: `1` } };
    window.dispatchEvent(new MessageEvent(`message`, { data: note, origin: `https://elsewhere.example` }));
    window.dispatchEvent(new MessageEvent(`message`, { data: { kind: `something else` }, origin: window.location.origin }));
    window.dispatchEvent(new MessageEvent(`message`, { data: note, origin: window.location.origin }));
    stop();
    window.dispatchEvent(new MessageEvent(`message`, { data: note, origin: window.location.origin }));
    expect(shown.mock.calls).toEqual([[{ ...ROG, monitor: `1` }]]);
});
