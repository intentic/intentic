import { describe, it, expect } from "bun:test";
import { mobileChatPath, onTabRoot, parseRoot, type TabRoot } from "./tabRoots";

// Files left the tab bar for the Menu, so /workspace stopped being a root while Review's /workspace?panel=changes
// stayed one: the two share a path, and only the panel tells them apart.
const ROOTS: readonly TabRoot[] = [{ path: `/agents` }, { path: `/menu` }, { path: `/workspace`, panel: `changes` }];

describe(`onTabRoot`, () => {
    it(`treats a tab's own screen and its drill-downs as on the root`, () => {
        expect(onTabRoot({ path: `/agents` }, ROOTS)).toBe(true);
        expect(onTabRoot({ path: `/agents/cnv_1` }, ROOTS)).toBe(true);
        expect(onTabRoot({ path: `/menu` }, ROOTS)).toBe(true);
    });

    it(`tells Review's Changes panel from the Files it shares a path with`, () => {
        expect(onTabRoot({ path: `/workspace`, panel: `changes` }, ROOTS)).toBe(true);
        expect(onTabRoot({ path: `/workspace` }, ROOTS)).toBe(false);
        expect(onTabRoot({ path: `/workspace`, panel: `history` }, ROOTS)).toBe(false);
    });

    it(`leaves a screen reached from the Menu to draw the shell's back arrow`, () => {
        expect(onTabRoot({ path: `/sandbox` }, ROOTS)).toBe(false);
        expect(onTabRoot({ path: `/agentsmith` }, ROOTS)).toBe(false);
    });

    it(`follows Review to the approvals extension when that pack is on`, () => {
        const roots: readonly TabRoot[] = [{ path: `/agents` }, { path: `/menu` }, { path: `/ext/approvals` }];
        expect(onTabRoot({ path: `/ext/approvals/queue` }, roots)).toBe(true);
        expect(onTabRoot({ path: `/workspace`, panel: `changes` }, roots)).toBe(false);
    });
});

describe(`parseRoot`, () => {
    it(`reads the panel off a destination that names one`, () => {
        expect(parseRoot(`/workspace?panel=changes`)).toEqual({ path: `/workspace`, panel: `changes` });
        expect(parseRoot(`/ext/approvals`)).toEqual({ path: `/ext/approvals` });
    });
});

describe(`mobileChatPath`, () => {
    it(`is the agent route, with the id escaped`, () => {
        expect(mobileChatPath(`cnv_1`)).toBe(`/agents/cnv_1`);
        expect(mobileChatPath(`a/b`)).toBe(`/agents/a%2Fb`);
    });
});
