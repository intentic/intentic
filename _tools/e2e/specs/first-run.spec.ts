import { expect, test } from "@playwright/test";

/* THE FIRST SESSION, in the browser: what somebody sees the moment setup finishes and the shell opens for the
 * first time. Both halves of it are decided by real state rather than by a flag a spec can set — the landing
 * reads whether this workspace has ever been delegated to, and the workspace pane reads whether the tree is
 * empty — so this drives the app the way a new user meets it and reads what it actually put on screen.
 *
 * Serial and first: `workers: 1` means these specs share one seeded world, and both facts under test here are
 * "nothing has happened yet". A spec that started an agent or uploaded a file before this one would be
 * asserting against a workspace that is no longer new. */
test.describe.configure({ mode: `serial` });

test(`the desktop's first landing is the agent board, asking for a task`, async ({ page }) => {
    // The shell's own entry, not /agents directly: the redirect IS what is under test.
    await page.goto(`/`);

    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole(`heading`, { name: `What should the first agent do?` })).toBeVisible();

    // The composer is empty and its send is inert until there is something to send.
    const composer = page.getByRole(`textbox`, { name: `What should the first agent do?` });
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(``);
    await expect(page.getByRole(`button`, { name: `Start agent` })).toBeDisabled();

    // A starter FILLS the box rather than dispatching an agent — the one rule every chip follows.
    await page.getByRole(`button`, { name: `Bring in my code` }).click();
    await expect(composer).toHaveValue(/Clone my repository into this workspace/);
    await expect(page.getByRole(`button`, { name: `Start agent` })).toBeEnabled();
    // Still the empty board: filling the composer is not starting anything.
    await expect(page.getByRole(`heading`, { name: `What should the first agent do?` })).toBeVisible();
});

test(`an empty workspace offers every way of getting code in, repository first`, async ({ page }) => {
    await page.goto(`/workspace`);

    await expect(page.getByText(`Get your code in`)).toBeVisible();
    // All three doors, and the repository one leads.
    const doors = [`Clone a repository`, `Upload files or a folder`, `Ask an agent to fetch it`];
    for (const door of doors) {
        await expect(page.getByRole(`button`, { name: new RegExp(door) })).toBeVisible();
    }

    // The clone door opens its field in place — the daemon has always had this route; nothing called it.
    await page.getByRole(`button`, { name: /Clone a repository/ }).click();
    const url = page.getByLabel(`Repository address`);
    await expect(url).toBeFocused();
    await expect(page.getByRole(`button`, { name: `Clone` })).toBeDisabled();
    await url.fill(`https://github.com/owner/repo.git`);
    await expect(page.getByRole(`button`, { name: `Clone` })).toBeEnabled();

    // The privacy promise survives the rebuild — it is the reason people are willing to use this pane at all.
    await expect(page.getByText(`Files stay on your sandbox machine`)).toBeVisible();
});
