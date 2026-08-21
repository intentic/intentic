import { expect, test } from "@playwright/test";

/* THE FIRST SESSION, in the browser: what somebody sees the moment setup finishes and the shell opens for the
 * first time. What each screen shows is decided by real state, the workspace pane reads whether the tree is
 * empty, the board reads whether anything is connected, so this drives the app the way a new user meets it
 * and reads what it actually put on screen.
 *
 * Serial and first: `workers: 1` means these specs share one seeded world, and every fact under test here is
 * "nothing has happened yet". A spec that started an agent or uploaded a file before this one would be
 * asserting against a workspace that is no longer new. */
test.describe.configure({ mode: `serial` });

test(`the first landing is the workspace`, async ({ page }) => {
    // The shell's own entry, not /workspace directly: the redirect IS what is under test. Desktop lands on the
    // workspace, the code, the doors for getting code in, and the docked chat already sitting to be typed at.
    await page.goto(`/`);

    await expect(page).toHaveURL(/\/workspace$/);
});

test(`the agent board asks for a task rather than for a sign-in`, async ({ page }) => {
    await page.goto(`/agents`);

    await expect(page.getByRole(`heading`, { name: `Start your first agent` })).toBeVisible();

    /* NOTHING IS CONNECTED ON A FRESH SANDBOX, and this screen used to answer that with a sign-in card: "Try
     * free with Google" as a headline, a Continue button, and the paid subscriptions as a row under it, filling
     * the middle of the board. It was the first thing a new user saw after signing in WITH GOOGLE, so it read
     * as a failed sign-in or as a product needing a subscription, and neither is true. */
    await expect(page.getByText(`Try free with Google`)).toHaveCount(0);
    await expect(page.getByRole(`button`, { name: /Continue with Google/ })).toHaveCount(0);

    // What stands here instead: tasks to press. This world has no repositories, so it is the build ladder.
    await expect(page.getByRole(`button`, { name: `A page for my business` })).toBeVisible();

    // THE ONE COMPOSER IN THIS PRODUCT IS THE CHAT'S. The board used to carry a second one here.
    await expect(page.getByRole(`textbox`, { name: `What should the first agent do?` })).toHaveCount(0);
    await expect(page.getByRole(`button`, { name: `Start agent` })).toHaveCount(0);

    /* And what a chat can send with is said once, in the chat, as one line with the model list behind it: the
     * offer now lives where the choice is made (the picker leads its locked rows with the free Google sign-in)
     * rather than in front of everybody who signs up. */
    await expect(page.getByText(`Claude isn't connected in this sandbox`)).toBeVisible();
    await expect(page.getByRole(`button`, { name: `Choose a model` })).toBeVisible();
});

test(`an empty workspace offers every way of getting code in, repository first`, async ({ page }) => {
    await page.goto(`/workspace`);

    await expect(page.getByText(`Get your code in`)).toBeVisible();
    // All three doors, and the repository one leads.
    const doors = [`Clone a repository`, `Upload files or a folder`, `Ask an agent to fetch it`];
    for (const door of doors) {
        await expect(page.getByRole(`button`, { name: new RegExp(door) })).toBeVisible();
    }

    // The clone door opens its field in place, the daemon has always had this route; nothing called it.
    await page.getByRole(`button`, { name: /Clone a repository/ }).click();
    const url = page.getByLabel(`Repository address`);
    await expect(url).toBeFocused();
    await expect(page.getByRole(`button`, { name: `Clone` })).toBeDisabled();
    await url.fill(`https://github.com/owner/repo.git`);
    await expect(page.getByRole(`button`, { name: `Clone` })).toBeEnabled();

    // The privacy promise survives the rebuild, it is the reason people are willing to use this pane at all.
    await expect(page.getByText(`Files stay on your sandbox machine`)).toBeVisible();
});
