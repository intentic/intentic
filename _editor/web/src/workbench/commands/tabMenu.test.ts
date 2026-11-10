import type { MenuItem } from "primevue/menuitem";
import { fileTabMenu, tabStripMenu } from "./tabMenu";

// The rows as a reader sees them: labels in order, separators as `---`, a disabled row marked.
const rows = (items: readonly MenuItem[]): string[] =>
    items.map((item) => (item.separator === true ? `---` : `${String(item.label)}${item.disabled === true ? ` (disabled)` : ``}`));

const noop = (): void => undefined;

describe(`the file-tab menu`, () => {
    it(`draws every strip's tab in one order: keep, place, close group, strip rows, copy path`, () => {
        const items = fileTabMenu(`side`, {
            keep: noop,
            place: { label: `Open in Workspace`, icon: `expand`, command: `side.openInSection`, run: noop },
            close: noop,
            closeOthers: noop,
            closeToRight: noop,
            closeAll: noop,
            reopen: noop,
            copyPath: { path: `a.ts`, root: () => undefined },
        });

        expect(rows(items)).toEqual([
            `ui.action.keepOpen`,
            `---`,
            `Open in Workspace`,
            `---`,
            `ui.action.close`,
            `workspace.workspaceDesktop.closeOthers`,
            `ui.action.closeToRight`,
            `---`,
            `workspace.workspaceDesktop.closeAll`,
            `workspace.workspaceDesktop.reopenClosedTab`,
            `---`,
            `workspace.workspaceDesktop.copyPath`,
        ]);
    });

    it(`keeps its shape with nothing to close beside the tab, and draws a place it cannot go to disabled`, () => {
        const items = fileTabMenu(`workspace`, {
            place: { label: `Open to the Side`, icon: `split-columns`, command: `workspace.splitEditor`, disabled: true, run: noop },
            close: noop,
            closeAll: noop,
        });

        expect(rows(items)).toEqual([
            `Open to the Side (disabled)`,
            `---`,
            `ui.action.close`,
            `workspace.workspaceDesktop.closeOthers (disabled)`,
            `ui.action.closeToRight (disabled)`,
            `---`,
            `workspace.workspaceDesktop.closeAll`,
        ]);
    });

    it(`gives the strip's empty space only the strip-wide rows, and nothing on an empty strip`, () => {
        expect(rows(tabStripMenu(`side`, { closeAll: noop, reopen: noop }))).toEqual([
            `workspace.workspaceDesktop.closeAll`,
            `workspace.workspaceDesktop.reopenClosedTab`,
        ]);
        expect(tabStripMenu(`workspace`, {})).toEqual([]);
    });
});
