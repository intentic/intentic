import { expect, test } from "@playwright/test";

/* THE FIRST SESSION, in the browser: what somebody sees the moment setup finishes and the shell opens for the
 * first time. What each screen shows is decided by real state rather than by a flag a spec can set — the
 * workspace pane reads whether the tree is empty, the board reads whether anything is connected — so this
 * drives the app the way a new user meets it and reads what it actually put on screen.
 *
 * Serial and first: `workers: 1` means these specs share one seeded world, and every fact under test here is
 * "nothing has happened yet". A spec that started an agent or uploaded a file before this one would be
 * asserting against a workspace that is no longer new. */
test.describe.configure({ mode: `serial` });

test(`the first landing gives something before it asks for anything`, async ({ page }) => {
    /* The shell's own entry, not /start directly: the redirect IS what is under test. A sandbox nobody has
     * done anything on lands here rather than on the workspace, because every other surface in this product is
     * evidence-driven — the board's starters read the repos, the capability recommendations read the remotes —
     * so an empty box makes all of them silent at once, which is the worst possible moment for the product to
     * have nothing to say. (A browser that has answered this screen once goes back to /workspace; that is the
     * localStorage flag in pages/start/firstRun.ts, and this context is fresh.) */
    await page.goto(`/`);

    await expect(page).toHaveURL(/\/start$/);

    /* NOTHING IS CONNECTED ON A FRESH SANDBOX, so this screen is the way in rather than a question it could
     * not act on — the same card the chat's gate and the empty board show (ConnectOffer). */
    await expect(page.getByText(`Try free with Google`)).toBeVisible();
    // And it is never in the way: somebody who arrived with their own repository leaves in one press.
    await expect(page.getByRole(`button`, { name: `Skip — I have my own code` })).toBeVisible();
});

test(`skipping the first-run screen lands on the workspace, and it stays skipped`, async ({ page }) => {
    await page.goto(`/start`);
    await page.getByRole(`button`, { name: `Skip — I have my own code` }).click();

    await expect(page).toHaveURL(/\/workspace$/);

    // The whole point of the flag: the offer is answered, so the shell's entry goes back to what it always was.
    await page.goto(`/`);
    await expect(page).toHaveURL(/\/workspace$/);
});

test(`the agent board offers the way in rather than a box it cannot send from`, async ({ page }) => {
    await page.goto(`/agents`);

    await expect(page.getByRole(`heading`, { name: `Start your first agent` })).toBeVisible();

    /* NOTHING IS CONNECTED ON A FRESH SANDBOX, so the first screen is the way in rather than a task box that
     * could not send. It is the chat's own card (ConnectOffer), and it stands in the middle of the board — the
     * free channel as the headline, the subscriptions as a quiet row under it. */
    await expect(page.getByText(`Try free with Google`)).toBeVisible();
    await expect(page.getByRole(`button`, { name: /Continue with Google/ })).toBeVisible();
    await expect(page.getByRole(`button`, { name: /Claude — Connect Claude subscription/ })).toBeVisible();

    // THE ONE COMPOSER IN THIS PRODUCT IS THE CHAT'S. The board used to carry a second one here.
    await expect(page.getByRole(`textbox`, { name: `What should the first agent do?` })).toHaveCount(0);
    await expect(page.getByRole(`button`, { name: `Start agent` })).toHaveCount(0);

    // And the docked chat drops its copy of the same card while the board is making the offer — one offer on
    // screen, not two a hand's width apart.
    await expect(page.getByText(`Try free with Google`)).toHaveCount(1);
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
