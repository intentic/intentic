import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { fileTabMenu, tabStripMenu } from "./tabMenu";

// The rows as a reader sees them: labels in order, separators as `---`, a disabled row marked.
const rows = (items: readonly MenuItem[]): string[] =>
    items.map((item) => (item.separator === true ? `---` : `${String(item.label)}${item.disabled === true ? ` (disabled)` : ``}`));

const noop = (): void => undefined;


// Labels go through the same `t`: whether a key reads as itself or as its English depends on whether an earlier
// file in this test process registered the app's catalog.
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
            t(`ui.action.keepOpen`),
            `---`,
            `Open in Workspace`,
            `---`,
            t(`ui.action.close`),
            t(`workspace.workspaceDesktop.closeOthers`),
            t(`ui.action.closeToRight`),
            `---`,
            t(`workspace.workspaceDesktop.closeAll`),
            t(`workspace.workspaceDesktop.reopenClosedTab`),
            `---`,
            t(`workspace.workspaceDesktop.copyPath`),
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
            t(`ui.action.close`),
            `${t(`workspace.workspaceDesktop.closeOthers`)} (disabled)`,
            `${t(`ui.action.closeToRight`)} (disabled)`,
            `---`,
            t(`workspace.workspaceDesktop.closeAll`),
        ]);
    });

    it(`gives the strip's empty space only the strip-wide rows, and nothing on an empty strip`, () => {
        expect(rows(tabStripMenu(`side`, { closeAll: noop, reopen: noop }))).toEqual([
            t(`workspace.workspaceDesktop.closeAll`),
            t(`workspace.workspaceDesktop.reopenClosedTab`),
        ]);
        expect(tabStripMenu(`workspace`, {})).toEqual([]);
    });
});
