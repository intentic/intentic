import { expect, type Locator, type Page } from "@playwright/test";

// Asks Home for a new sandbox, says it runs from a command on a server, and picks a lane's tab of that command.
//
// (2026-10-26) /setup is gone: a new sandbox is made on Home, in a dialog over it (features/home/newSandbox/), and every
// old address of /setup redirects there (router/setupRoutes.ts). The command for a server is one of the dialog's "More
// ways", folded under the one-press picks unless nothing else is offered. After Create, a first sandbox keeps its run's
// page, where the command is drawn; a reader who already has a sandbox (every lane after the first, since all lanes share
// one seeded account) is put back on Home's chat with the run behind a tile of its own, and pressing the tile brings
// the page back. Waiting for the old page's "Show the command" fold and "Add another sandbox" press timed out on both
// lanes from run 40428670601.

/** Home's address asking for a new sandbox: the dialog over Home. */
export const NEW_SANDBOX_PATH = `/home?add=sandbox`;

// Every spelling of a tab, since its accessible role depends on how the control happened to be built.
const runTab = (page: Page, name: RegExp, exact: string): Locator =>
    page
        .getByRole(`radio`, { name })
        .or(page.getByRole(`button`, { name }))
        .or(page.getByRole(`tab`, { name }))
        .or(page.getByText(exact, { exact: true }));

// From Home's dialog (NEW_SANDBOX_PATH, already loaded) to the command's tab. The first wait is patient: the dialog reads
// what it can offer while a cold world's SPA is still fetching its own chunks.
export const openRunTab = async (page: Page, name: RegExp, exact: string): Promise<void> => {
    const way = page.locator(`[data-add-sandbox-way="command"]`);
    const more = page.locator(`[data-add-sandbox-more]`);
    await expect(way.or(more).first()).toBeVisible({ timeout: 180_000 });
    if (!(await way.isVisible())) {
        await more.click();
    }
    await way.click();
    await page
        .locator(`[data-new-sandbox-create]`)
        .or(page.getByRole(`button`, { name: `Create sandbox`, exact: true }))
        .first()
        .click();

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
