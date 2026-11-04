import { page as pages } from "@intentic/sandbox-contract/app-routes";
import { expect, test } from "@playwright/test";
import { DAEMON_URL, seededPage } from "../stack.js";

const WORKSPACE = seededPage(pages.workspace());

// First-run screens read real state: a fresh sandbox seeds and starts a running starter site, not an empty tree. Serial
// (workers: 1) shares one seeded world; every fact here assumes nothing has happened in it yet.
test.describe.configure({ mode: `serial` });

test(`the first landing is the starter site, already running`, async ({ page }) => {
    // Goes to the shell's own entry (not the preview) since the automatic redirect there is itself under test. The live
    // app's page is a tab of the sandbox's Browsers (2026-10-08), named after the app it shows.
    await page.goto(`/`);

    await expect(page).toHaveURL(new RegExp(`${seededPage(pages.browsers())}(?:/[^/?#]+)?$`));
    await expect(page.getByLabel(`Which app to preview`)).toBeVisible();
    await expect(page.getByRole(`button`, { name: `Stop` })).toBeVisible();
    await expect(page.frameLocator(`iframe`).locator(`body`)).toBeVisible();

    // One-time redirect: after the first landing, a reload keeps wherever the reader last navigated to.
    await page.goto(WORKSPACE);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${WORKSPACE}$`));
});

test(`the agent board asks for a task rather than for a sign-in`, async ({ page }) => {
    await page.goto(seededPage(pages.agents()));

    await expect(page.getByRole(`heading`, { name: `Start your first agent` })).toBeVisible();

    await expect(page.getByText(`Try free with Google`)).toHaveCount(0);
    await expect(page.getByRole(`button`, { name: /Continue with Google/ })).toHaveCount(0);

    await expect(page.getByRole(`button`, { name: `Explain this codebase` })).toBeVisible();

    await expect(page.getByRole(`textbox`, { name: `What should the first agent do?` })).toHaveCount(0);
    await expect(page.getByRole(`button`, { name: `Start agent` })).toHaveCount(0);

    // Nothing is connected here and nobody has chosen anything, so no vendor is named: the app is not one vendor's.
    // The one press is connecting a model; the composer's pill states the chat has none, and is no second door.
    await expect(page.getByText(`No model is connected in this sandbox yet.`)).toBeVisible();
    await expect(page.getByRole(`link`, { name: `Connect a model`, exact: true })).toBeVisible();
    await expect(page.getByRole(`button`, { name: `Choose a model`, exact: true })).toHaveCount(0);
    await expect(page.getByText(`isn't connected in this sandbox`)).toHaveCount(0);
});

// Runs last: it empties the workspace, and every other spec in this suite assumes it still has the starter site.
test(`a workspace with nothing in it offers every way of getting code in, repository first`, async ({ page, request }) => {
    const cleared = await request.delete(`${DAEMON_URL}/workspace/entry`, { data: { path: `site` } });
    expect(cleared.ok()).toBe(true);

    await page.goto(WORKSPACE);

    await expect(page.getByText(`Get your code in`)).toBeVisible();
    // The address field is open from the start; the other two ways in are buttons beside each other under it.
    const url = page.getByLabel(`Repository address`);
    await expect(url).toBeVisible();
    for (const door of [`Upload files`, `Ask an agent`]) {
        await expect(page.getByRole(`button`, { name: door, exact: true })).toBeVisible();
    }

    await expect(page.getByRole(`button`, { name: `Clone` })).toBeDisabled();
    await url.fill(`https://github.com/owner/repo.git`);
    await expect(page.getByRole(`button`, { name: `Clone` })).toBeEnabled();

    await expect(page.getByText(`Files stay on your sandbox machine`)).toBeVisible();
});
