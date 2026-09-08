import { errorMessage } from "@intentic/base/errors";
import { expect, test } from "@playwright/test";
import { readWorldFile } from "../src/world-file.js";

// Asserts world facts the journey would otherwise hit as confusing failures later: an unsubstituted api origin looks
// like a broken login, a trial not switched on looks like an empty picker.

const world = readWorldFile();

test.skip(world.standDown !== undefined, world.standDown ?? ``);

test(`the SPA is served and knows where its api is`, async ({ page }) => {
    await page.goto(world.webUrl ?? ``);

    // Api origin is a `$API_URL` placeholder, substituted by the image's entrypoint at container start.
    const configured = await page.evaluate(() => (window as unknown as { env?: { api?: { url?: string } } }).env?.api?.url);
    expect(configured).toBe(world.apiUrl);
});

test(`the browser can call the api from the app's own origin`, async ({ page }) => {
    await page.goto(world.webUrl ?? ``);

    // Only check hitting the api from the page (cross-origin, credentialed); node-side pings don't cover this.
    const result = await page.evaluate(async (apiUrl) => {
        try {
            const response = await fetch(`${apiUrl}/api/auth/get-session`, { credentials: `include` });
            return { reached: true, status: response.status, signedIn: ((await response.json()) as { user?: unknown } | null)?.user !== undefined };
        } catch (error) {
            return { reached: false, why: errorMessage(error) };
        }
    }, world.apiUrl ?? ``);

    expect(result).toMatchObject({ reached: true, status: 200 });
    // Every spec after this assumes the seeded session it sees here.
    expect(result).toMatchObject({ signedIn: true });
});

test(`the login page offers a way in`, async ({ page }) => {
    await page.goto(`${world.webUrl ?? ``}/login`);

    // Which button renders depends on Google's script loading; asserting either avoids flaking on that availability.
    const ownButton = page.getByRole(`button`, { name: /Continue with Google/ });
    const escapeLink = page.getByRole(`button`, { name: /Trouble signing in/ });

    await expect(ownButton.or(escapeLink).first()).toBeVisible();
});

test(`the platform is up and its free trial is switched on`, async ({ request }) => {
    expect((await request.get(`${world.apiUrl ?? ``}/api/auth/ok`)).status()).toBeLessThan(500);

    // Both refusals are 404 by design; message text, not status, tells an unknown sandbox from a disabled trial.
    const refusal = await request.post(`${world.apiUrl ?? ``}/trial/v1/chat/completions`, {
        headers: { authorization: `Bearer not-a-real-sandbox`, "content-type": `application/json` },
        data: { model: `whatever`, messages: [] },
    });

    expect(refusal.status()).toBe(404);
    expect(await refusal.text()).toContain(`unknown sandbox`);
});
