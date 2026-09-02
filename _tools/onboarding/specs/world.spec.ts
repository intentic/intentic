import { errorMessage } from "@intentic/base/errors";
import { expect, test } from "@playwright/test";
import { readWorldFile } from "../src/world-file.js";

/* THE WORLD THE JOURNEY RESTS ON, asserted before anything rests on it.
 *
 * Every fact here is one the journey would otherwise discover as a confusing failure three steps later: a SPA
 * whose api origin was never substituted looks like a broken login, and a platform whose trial never switched on
 * looks like a picker with no models. Each is a different bug and neither says its own name, so they are checked
 * once, here, where they can.
 */

const world = readWorldFile();

test.skip(world.standDown !== undefined, world.standDown ?? ``);

test(`the SPA is served and knows where its api is`, async ({ page }) => {
    await page.goto(world.webUrl ?? ``);

    /* The api origin is a `$API_URL` placeholder in the built bundle, substituted by the image's entrypoint at
     * container start. A run where that did not happen serves a SPA that calls a literal `$API_URL`, every
     * request fails, and the only visible symptom is a login page that never signs anybody in. */
    const configured = await page.evaluate(() => (window as unknown as { env?: { api?: { url?: string } } }).env?.api?.url);
    expect(configured).toBe(world.apiUrl);
});

test(`the browser can call the api from the app's own origin`, async ({ page }) => {
    await page.goto(world.webUrl ?? ``);

    /* THE ASSERTION THE WHOLE TIER RESTS ON, and the one nothing else makes.
     *
     * Every other check here reaches the api from node, which proves the api is up and proves nothing about
     * the journey: the app calls it from a page, cross-origin, with credentials, and that call is allowed only
     * if the api was told this exact origin. Get that wrong and the router sends every route to "Intentic
     * isn't reachable", a screen that names the network, so the reader looks anywhere but at the one setting
     * responsible. */
    const result = await page.evaluate(async (apiUrl) => {
        try {
            const response = await fetch(`${apiUrl}/api/auth/get-session`, { credentials: `include` });
            return { reached: true, status: response.status, signedIn: ((await response.json()) as { user?: unknown } | null)?.user !== undefined };
        } catch (error) {
            return { reached: false, why: errorMessage(error) };
        }
    }, world.apiUrl ?? ``);

    expect(result).toMatchObject({ reached: true, status: 200 });
    // And the seeded session is the one it sees, which is what every spec after this assumes.
    expect(result).toMatchObject({ signedIn: true });
});

test(`the login page offers a way in`, async ({ page }) => {
    await page.goto(`${world.webUrl ?? ``}/login`);

    /* EITHER door, not a named one, and that is the assertion rather than a hedge.
     *
     * The page has two shapes and which one a visitor gets is decided by Google, not by us: when Google's
     * script arrives and renders its own button, the page shows that plus an escape link underneath; when it
     * does not, the page falls back to a control of ours that goes the redirect way. A test that demanded one
     * of them would be asserting Google's availability from a CI runner, and would go red for the one reason
     * this tier must never go red for.
     *
     * What the product actually promises is that SOMETHING here can be clicked, the rule B5's unit matrix
     * states for every surface. This is the built, containerised, real-browser proof of the same rule. */
    const ownButton = page.getByRole(`button`, { name: /Continue with Google/ });
    const escapeLink = page.getByRole(`button`, { name: /Trouble signing in/ });

    await expect(ownButton.or(escapeLink).first()).toBeVisible();
});

test(`the platform is up and its free trial is switched on`, async ({ request }) => {
    expect((await request.get(`${world.apiUrl ?? ``}/api/auth/ok`)).status()).toBeLessThan(500);

    /* Both refusals are 404, deliberately, so a probe cannot tell a wrong token from a closed route, so the
     * two are told apart by what they say. "unknown sandbox" means the trial IS enabled and merely does not
     * know this caller, which is exactly the state the journey needs. "not enabled" would mean TRIAL_KEYS never
     * reached the container, and every model list downstream would be empty for a reason nothing else names. */
    const refusal = await request.post(`${world.apiUrl ?? ``}/trial/v1/chat/completions`, {
        headers: { authorization: `Bearer not-a-real-sandbox`, "content-type": `application/json` },
        data: { model: `whatever`, messages: [] },
    });

    expect(refusal.status()).toBe(404);
    expect(await refusal.text()).toContain(`unknown sandbox`);
});
