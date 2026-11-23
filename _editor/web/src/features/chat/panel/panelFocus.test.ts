import { describePanels, type DrawnPanel, panelsAgree, panelVerdict, repairsFor } from "./panelFocus";

// Pins how the focus check reads the panels on the page against the focused chat (panelFocusWatch.ts): only a live panel
// on screen that draws another chat is stale, any panel nobody owns is a leftover wherever it stands, and each finding
// asks for its own repair. On 2026-11-23 the board ringed the clicked card while the docked chat drew another one.

const live = (focus: string | undefined, onScreen = true): DrawnPanel => ({ focus, live: true, onScreen });
const orphan = (focus: string, onScreen = true): DrawnPanel => ({ focus, live: false, onScreen });

describe(`the panel focus verdict`, () => {
    it(`agrees when every live panel on screen draws the focused chat`, () => {
        const verdict = panelVerdict(`crisp-badger-0i91`, [live(`crisp-badger-0i91`)]);
        expect(verdict).toEqual({ stale: 0, orphans: 0 });
        expect(panelsAgree(verdict)).toBe(true);
        expect(repairsFor(verdict, true)).toEqual([]);
    });

    it(`calls a live panel on screen that draws another chat stale, and builds it again when the focus has a tab`, () => {
        const verdict = panelVerdict(`crisp-badger-0i91`, [live(`brook-hbbu`)]);
        expect(verdict).toEqual({ stale: 1, orphans: 0 });
        expect(panelsAgree(verdict)).toBe(false);
        expect(repairsFor(verdict, true)).toEqual([`remount`]);
    });

    it(`moves the focus instead when it names a chat with no tab, whose floor the panel is right to draw`, () => {
        expect(repairsFor(panelVerdict(`crisp-badger-0i91`, [live(`brook-hbbu`)]), false)).toEqual([`refocus`]);
    });

    it(`leaves a panel nobody can see alone, whatever it last drew`, () => {
        expect(panelVerdict(`crisp-badger-0i91`, [live(`brook-hbbu`, false), live(undefined, false)])).toEqual({ stale: 0, orphans: 0 });
    });

    it(`calls a panel nobody owns a leftover, on screen or off, and drops it before anything else`, () => {
        const verdict = panelVerdict(`crisp-badger-0i91`, [orphan(`brook-hbbu`), orphan(`crisp-badger-0i91`, false), live(`crisp-badger-0i91`)]);
        expect(verdict).toEqual({ stale: 0, orphans: 2 });
        expect(repairsFor(verdict, true)).toEqual([`drop-orphans`]);
        expect(repairsFor({ stale: 1, orphans: 1 }, true)).toEqual([`drop-orphans`, `remount`]);
    });

    it(`says each panel in one line, for the report`, () => {
        expect(describePanels([live(`brook-hbbu`), orphan(`crisp-badger-0i91`, false), live(undefined)])).toBe(
            `brook-hbbu:live:shown crisp-badger-0i91:orphan:hidden none:live:shown`,
        );
    });
});
