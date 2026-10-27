import { expect, type Locator, type Page } from "@playwright/test";

// Both provisioning lanes use Home's new sandbox dialog and its command for a server. The code is minted only after
// Create. A first sandbox keeps its run page; an account with another sandbox returns to its chat, with the run
// behind its own tile. All lanes share that account, so both arrivals matter here. /setup now redirects to Home;
// waiting for its old command fold and add-another press timed out on both lanes in run 40428670601.

/** Home's address asking for a new sandbox: the dialog over Home. */
export const NEW_SANDBOX_PATH = `/home?add=sandbox`;

// Every spelling of a tab, since its accessible role depends on how the control happened to be built.
const runTab = (page: Page, name: RegExp, exact: string): Locator =>
    page
        .getByRole(`radio`, { name })
        .or(page.getByRole(`button`, { name }))
        .or(page.getByRole(`tab`, { name }))
        .or(page.getByText(exact, { exact: true }));

// Opens the command and selects a lane's tab. The waits include the cold world's SPA chunks, offers and code mint.
export const openRunTab = async (page: Page, name: RegExp, exact: string): Promise<void> => {
    const dialog = page.getByRole(`dialog`, { name: `New sandbox`, exact: true });
    await expect(dialog).toBeVisible({ timeout: 180_000 });
    const way = dialog.locator(`[data-add-sandbox-way="command"]`);
    const more = dialog.locator(`[data-add-sandbox-more]`);

    // With no one-press machine on offer, More ways is already expanded.
    await expect(way.or(more).first()).toBeVisible({ timeout: 180_000 });
    if (!(await way.isVisible())) {
        await more.click();
    }
    await way.click();
    await dialog
        .locator(`[data-new-sandbox-create]`)
        .or(dialog.getByRole(`button`, { name: `Create sandbox`, exact: true }))
        .first()
        .click();
    await expect(dialog).toBeHidden({ timeout: 180_000 });

    const command = page.locator(`[data-add-sandbox-command]`);
    const tile = page.locator(`[data-new-sandbox-tile]`);
    await expect(command.or(tile).first()).toBeVisible({ timeout: 180_000 });
    if (!(await command.isVisible())) {
        await tile.click();
        await expect(command).toBeVisible({ timeout: 60_000 });
    }

    const tab = runTab(page, name, exact);
    await expect(tab.first()).toBeVisible({ timeout: 60_000 });
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
