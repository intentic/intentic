import { expect, type Locator, type Page } from "@playwright/test";

/* THE WIZARD'S RUN STEP, AND THE FOLD IN FRONT OF IT.
 *
 * Every lane that gets a sandbox through the browser needs the same two clicks: open the run step's tab strip,
 * then pick its own tab. They are here rather than in each provisioner because the SECOND of those clicks was
 * spelled twice, and the FIRST was spelled nowhere — which is what this file was written for.
 *
 * WHAT THE FOLD IS. For a browser on a platform we ship a desktop build for, step 2 of the wizard IS the app:
 * the download is the offer, and every command — the terminal one-liner, the compose file — is folded behind
 * one "Show the command" link (Setup.vue's `appFirst`). This tier is ALWAYS that browser, because Playwright's
 * `Desktop Chrome` descriptor carries a Windows user agent, so the page it lands on is the one whose tab strip
 * has not been rendered yet. Both lanes waited three minutes for a tab behind a link nobody clicked, and the
 * report was a locator that found nothing rather than a screen that was waiting to be opened.
 *
 * The click is tolerant on purpose: a reader whose platform we ship no build for gets the tabs unfolded, and
 * there is then no control to press. So this waits for EITHER, and only opens the fold when the fold is what
 * showed up.
 */

/* Every spelling of a tab, because it is a segmented control whose role depends on how it is built, and this
 * tier should fail on the wizard not reaching its run step rather than on that detail. */
const runTab = (page: Page, name: RegExp, exact: string): Locator =>
    page
        .getByRole(`radio`, { name })
        .or(page.getByRole(`button`, { name }))
        .or(page.getByRole(`tab`, { name }))
        .or(page.getByText(exact, { exact: true }));

/* Open the run step and select one lane's tab.
 *
 * Patient on the first wait, and deliberately so: step 1 is not instant. A row is created, a reachability
 * grant is minted and a setup code issued, and on a cold world the SPA is still fetching its own chunks while
 * that happens. A minute was enough most of the time, which is the worst amount of time for a gate to allow.
 */
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

/* A step's own block on that panel: the one that carries this label AND a Copy button.
 *
 * Both filters earn their keep. The label alone matches every ancestor div down to the one holding the text
 * and nothing else, and `.last()` picks exactly that innermost one — a text node with no button in it, which
 * is a Copy that times out 30 seconds later saying only that it could not find a button. Requiring the button
 * makes `.last()` mean "the smallest block that has both", which is the block a reader would point at.
 */
export const copyBlockFor = (page: Page, label: string): Locator =>
    page
        .locator(`div`)
        .filter({ hasText: label })
        .filter({ has: page.getByRole(`button`, { name: `Copy` }) })
        .last();
