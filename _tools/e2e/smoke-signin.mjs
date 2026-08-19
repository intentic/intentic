#!/usr/bin/env node
/* CAN A STRANGER ACTUALLY SIGN IN TO THE DEPLOYED SITE? — the one question no other check in this repo asks.
 *
 * The browser e2e tier covers the login journey with a SEEDED session and no real Google ("no real Google" is
 * the first line of its config, and it is the right call for a suite that must run offline and hermetically).
 * Every unit test around sign-in mocks Google too. So the whole pipeline could be green while the front door
 * was shut, and it was: Google began refusing the deployed origin for the OAuth client, every in-page Google
 * button on the site went dead, and nothing anywhere went red. That is the gap this closes.
 *
 * WHY A REAL BROWSER, when a curl would be a hundred times cheaper. It was tried. Requesting Google's button
 * endpoint with the right origin, referer, user-agent, fetch-metadata headers and even the page's own `cas`
 * value answers 200 while a real Chromium loading the real page is answered 400 for the identical URL. A curl
 * check would therefore have been GREEN through the whole outage — worse than no check, because it would have
 * been believed. Google decides this inside the browser, so it has to be asked inside one.
 *
 * WHAT IT ASSERTS, and why it is these two things:
 *   1. Google's button reaches a real size. A rejected button still exists in the DOM at 0×0 — "is it there"
 *      is not the question, "can it be pressed" is.
 *   2. The escape link is on the page. Some ways that button can fail are invisible to the page itself, so
 *      the way in that depends on none of Google's frame machinery must never quietly disappear.
 *
 * Run after a deploy (ci.yml), against the origin that was just deployed:
 *   pnpm --filter @intentic-app/e2e smoke:signin https://app.intentic.dev
 */

import { chromium } from "@playwright/test";

const origin = (process.argv[2] ?? process.env.WEB_ORIGIN ?? "https://app.intentic.dev").replace(/\/+$/, "");
const loginUrl = `${origin}/login`;

// Google's script, its frame and the app's own bundle all have to land. Generous because this runs seconds
// after a deploy, against a container that has served almost nothing yet.
const BUTTON_DEADLINE_MS = 30_000;

// The exact string Google Identity Services logs when the client will not accept this page's origin. Matched
// because it names the cause precisely, and a failure that names its cause is repaired in minutes rather than
// bisected for a day.
const ORIGIN_REFUSED = /origin is not allowed for the given client/i;

const fail = (message, detail) => {
    console.error(`\nsign-in smoke FAILED against ${loginUrl}`);
    console.error(`  ${message}`);
    for (const line of detail ?? []) {
        console.error(`  ${line}`);
    }
    process.exitCode = 1;
};

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (message) => {
    if (message.type() === "error") {
        consoleErrors.push(message.text());
    }
});

try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: BUTTON_DEADLINE_MS });

    /* A pressable button, not merely a present one. Google renders its button into a cross-origin iframe; when
     * the client refuses the origin that iframe is created and then stays 0×0 forever, which is exactly what a
     * user sees as "the button does nothing". Waiting on the SIZE is what tells the two apart. */
    const pressable = await page
        .waitForFunction(
            () => {
                const frame = document.querySelector('iframe[src*="gsi/button"]');
                return frame instanceof HTMLElement && frame.clientWidth > 0 && frame.clientHeight > 0;
            },
            undefined,
            { timeout: BUTTON_DEADLINE_MS },
        )
        .then(() => true)
        .catch(() => false);

    const refused = consoleErrors.filter((text) => ORIGIN_REFUSED.test(text));

    if (refused.length > 0) {
        fail("Google is refusing this origin for the sign-in client — the front door is shut.", [
            "",
            `Google said: ${refused[0]}`,
            "",
            "Google names the console, but there are TWO causes and the message cannot tell them apart,",
            "because both reach Google as an origin it cannot match. Check the cheap one first:",
            "",
            `  1. WE STOPPED SENDING THE ORIGIN. Google reads it off the Referer of the browser's request`,
            `     for accounts.google.com/gsi/button, so a Referrer-Policy of no-referrer on our own`,
            `     responses refuses every origin, including a correctly-listed one. Check it with:`,
            `         curl -sSI ${origin}/login | grep -i referrer-policy`,
            `     Anything sending the origin cross-origin is fine (strict-origin-when-cross-origin);`,
            `     no-referrer is the bug, and it is ours — see _editor/web/nginx.conf.`,
            "",
            `  2. GOOGLE STOPPED ACCEPTING IT. In the Google Cloud console, open the OAuth client the`,
            `     deployment uses and make sure this exact origin is listed under Authorized JavaScript`,
            `     origins: ${origin}. It can take Google minutes to hours to apply a change there.`,
        ]);
    } else if (!pressable) {
        fail("Google's sign-in button never became pressable (it stayed zero-sized).", [
            "",
            "Nothing named a cause, so the usual suspects are: the Identity Services script never",
            "loaded, or the page rendered it into a container that is hidden.",
            ...(consoleErrors.length > 0 ? ["", "Console errors seen:", ...consoleErrors.slice(0, 5).map((text) => `  - ${text}`)] : []),
        ]);
    }

    /* The way in that survives everything above. Whichever way Google's own button fails, some of those ways
     * cannot be detected from the page — so this link is the difference between a sign-in page that is having
     * a bad day and one that is simply a wall. It is not allowed to go missing quietly. */
    const escape = await page.getByText(/Google's own page/i).count();
    if (escape === 0) {
        fail("The sign-in page offers no fallback way in.", [
            "",
            "Some ways Google's button can fail are invisible to the page, so the link that",
            "bypasses it has to be there unconditionally (see Login.vue).",
        ]);
    }

    if (process.exitCode !== 1) {
        console.log(`sign-in smoke OK — Google's button is live on ${loginUrl}, and the fallback link is there.`);
    }
} catch (error) {
    fail(`the sign-in page did not load: ${error instanceof Error ? error.message : String(error)}`);
} finally {
    await browser.close();
}
