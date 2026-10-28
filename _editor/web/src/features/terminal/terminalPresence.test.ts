import { receiveDesktopShown } from "../../workbench/window/onScreen";
import { presenceChange, presenceReport, type TerminalPresence } from "./terminalPresence";

// A viewport as laid out: the DOM here does no layout, so its box is what each test says it is.
const viewport = (cols = 160, rows = 33): TerminalPresence & { box: (width: number, height: number) => void } => {
    const host = document.createElement(`div`);
    let size = { width: 0, height: 0 };
    Object.defineProperty(host, `clientWidth`, { get: () => size.width });
    Object.defineProperty(host, `clientHeight`, { get: () => size.height });
    return {
        host,
        requestedGrid: { cols, rows },
        box: (width, height) => {
            size = { width, height };
        },
    };
};

let visibility: DocumentVisibilityState = `visible`;
Object.defineProperty(document, `visibilityState`, { configurable: true, get: () => visibility });

afterEach(() => {
    visibility = `visible`;
    receiveDesktopShown(true);
    document.body.replaceChildren();
});

it(`reports the grid only while the pane is in sight, and away for a parked or collapsed viewport`, () => {
    const p = viewport();
    // Never mounted: the session a hidden tab opens for a tab nobody has looked at yet.
    expect(presenceReport(p)).toEqual({ type: `away` });
    document.body.append(p.host);
    p.box(1200, 540);
    expect(presenceReport(p)).toEqual({ type: `resize`, cols: 160, rows: 33 });
    // Collapsed to nothing, as a panel hidden by display:none measures.
    p.box(0, 540);
    expect(presenceReport(p)).toEqual({ type: `away` });
    p.box(1200, 540);
    p.host.remove();
    expect(presenceReport(p)).toEqual({ type: `away` });
});

it(`tells only a change: into sight, out of it, and nothing in between`, () => {
    const p = viewport();
    expect(presenceChange(p)).toBeUndefined();
    document.body.append(p.host);
    p.box(1200, 540);
    expect(presenceChange(p)).toEqual({ type: `resize`, cols: 160, rows: 33 });
    expect(presenceChange(p)).toBeUndefined();
    p.host.remove();
    expect(presenceChange(p)).toEqual({ type: `away` });
    expect(presenceChange(p)).toBeUndefined();
});

it(`counts a background tab and a window the desktop app hid as out of sight`, () => {
    const p = viewport();
    document.body.append(p.host);
    p.box(1200, 540);
    expect(presenceChange(p)).toEqual({ type: `resize`, cols: 160, rows: 33 });
    visibility = `hidden`;
    expect(presenceChange(p)).toEqual({ type: `away` });
    visibility = `visible`;
    expect(presenceChange(p)).toEqual({ type: `resize`, cols: 160, rows: 33 });
    receiveDesktopShown(false);
    expect(presenceChange(p)).toEqual({ type: `away` });
});
