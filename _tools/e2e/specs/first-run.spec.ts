import { expect, test } from "@playwright/test";
import { DAEMON_URL } from "../stack.js";

// First-run screens read real state: a fresh sandbox seeds and starts a running starter site, not an empty tree. Serial
// (workers: 1) shares one seeded world; every fact here assumes nothing has happened in it yet.
test.describe.configure({ mode: `serial` });

test(`the first landing is the starter site, already running`, async ({ page }) => {
    // Goes to the shell's own entry (not /preview) since the automatic redirect there is itself under test.
    await page.goto(`/`);

    await expect(page).toHaveURL(/\/preview$/);
    await expect(page.getByLabel(`Which app to preview`)).toBeVisible();
    await expect(page.getByRole(`button`, { name: `Stop` })).toBeVisible();
    await expect(page.frameLocator(`iframe`).locator(`body`)).toBeVisible();

    // One-time redirect: after the first landing, a reload keeps wherever the reader last navigated to.
    await page.goto(`/workspace`);
    await page.reload();
    await expect(page).toHaveURL(/\/workspace$/);
});

test(`the agent board asks for a task rather than for a sign-in`, async ({ page }) => {
    await page.goto(`/agents`);

    await expect(page.getByRole(`heading`, { name: `Start your first agent` })).toBeVisible();

    await expect(page.getByText(`Try free with Google`)).toHaveCount(0);
    await expect(page.getByRole(`button`, { name: /Continue with Google/ })).toHaveCount(0);

    await expect(page.getByRole(`button`, { name: `Explain this codebase` })).toBeVisible();

    await expect(page.getByRole(`textbox`, { name: `What should the first agent do?` })).toHaveCount(0);
    await expect(page.getByRole(`button`, { name: `Start agent` })).toHaveCount(0);

    // Nothing is connected here and nobody has chosen anything, so no vendor is named: the app is not one vendor's,
    // and the reader is pointed at the list rather than at somebody's sign-in.
    await expect(page.getByText(`No model is connected in this sandbox yet.`)).toBeVisible();
    // Exact, since the composer's own pill now reads the same words in a longer accessible name.
    await expect(page.getByRole(`button`, { name: `Choose a model`, exact: true })).toBeVisible();
    await expect(page.getByText(`isn't connected in this sandbox`)).toHaveCount(0);
});

// Runs last: it empties the workspace, and every other spec in this suite assumes it still has the starter site.
test(`a workspace with nothing in it offers every way of getting code in, repository first`, async ({ page, request }) => {
    const cleared = await request.delete(`${DAEMON_URL}/workspace/entry`, { data: { path: `site` } });
    expect(cleared.ok()).toBe(true);

    await page.goto(`/workspace`);

    await expect(page.getByText(`Get your code in`)).toBeVisible();
    const doors = [`Clone a repository`, `Upload files or a folder`, `Ask an agent to fetch it`];
    for (const door of doors) {
        await expect(page.getByRole(`button`, { name: new RegExp(door) })).toBeVisible();
    }

    await page.getByRole(`button`, { name: /Clone a repository/ }).click();
    const url = page.getByLabel(`Repository address`);
    await expect(url).toBeFocused();
    await expect(page.getByRole(`button`, { name: `Clone` })).toBeDisabled();
    await url.fill(`https://github.com/owner/repo.git`);
    await expect(page.getByRole(`button`, { name: `Clone` })).toBeEnabled();

    await expect(page.getByText(`Files stay on your sandbox machine`)).toBeVisible();
});
