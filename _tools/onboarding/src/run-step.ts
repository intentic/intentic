import { expect, type Locator, type Page } from "@playwright/test";

// Opens the run step's tab strip, then picks a lane's own tab; the second click was duplicated across provisioners and
// the first was missing. Playwright's Desktop Chrome always lands folded (behind "Show the command"), so this waits for
// either the tab or the fold, opening the fold only when that's what showed up.

// Every spelling of a tab, since its accessible role depends on how the control happened to be built.
const runTab = (page: Page, name: RegExp, exact: string): Locator =>
    page
        .getByRole(`radio`, { name })
        .or(page.getByRole(`button`, { name }))
        .or(page.getByRole(`tab`, { name }))
        .or(page.getByText(exact, { exact: true }));

// Opens the run step and selects a lane's tab. The first wait is patient: step 1 mints a grant and setup code while a
// cold world's SPA is still fetching its own chunks.
export const openRunTab = async (page: Page, name: RegExp, exact: string): Promise<void> => {
    const tab = runTab(page, name, exact);
    const reveal = page.getByRole(`button`, { name: /Show the command/u });

    await expect(tab.or(reveal).first()).toBeVisible({ timeout: 180_000 });
    if (!(await tab.first().isVisible())) {
        await reveal.first().click();
        await expect(tab.first()).toBeVisible({ timeout: 60_000 });
    }
    await tab.first().click();
};

// Block carrying both this label and a Copy button; label alone matches down to a text node with no button, timing out
// with a useless error. Requiring both makes `.last()` mean the smallest block containing them.
export const copyBlockFor = (page: Page, label: string): Locator =>
    page
        .locator(`div`)
        .filter({ hasText: label })
        .filter({ has: page.getByRole(`button`, { name: `Copy` }) })
        .last();
