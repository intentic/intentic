#!/usr/bin/env node
// The only check that signs in against Google for real: everything else runs seeded or mocked, so the pipeline can stay
// green while the button is dead. A curl to the button endpoint answers 200 where a real browser gets 400, so this must
// run inside one. Asserts:
// 1. Google's button reaches a real size; a refused button stays 0×0 in the DOM.
// 2. The fallback sign-in link is present, for failures invisible to the button itself.

import { chromium } from "@playwright/test";

const origin = (process.argv[2] ?? process.env.WEB_ORIGIN ?? "https://app.intentic.dev").replace(/\/+$/, "");
const loginUrl = `${origin}/login`;

// Generous: this runs seconds after deploy, before the container, Google's script and its frame have warmed up.
const BUTTON_DEADLINE_MS = 30_000;

// Exact string Google Identity Services logs when the OAuth client refuses this page's origin.
const ORIGIN_REFUSED = /origin is not allowed for the given client/i;

const fail = (message, detail) => {
    console.error(`\nsign-in smoke FAILED against ${loginUrl}`);
    console.error(`  ${message}`);
    for (const line of detail ?? []) {
        console.error(`  ${line}`);
    }
    process.exitCode = 1;
};

// Full chromium, not the headless shell: must be the browser a real visitor gets.
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (message) => {
    if (message.type() === "error") {
        consoleErrors.push(message.text());
    }
});

try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: BUTTON_DEADLINE_MS });

    // Checks size, not presence: a refused origin still renders the iframe, just stuck at 0×0.
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
        fail("Google is refusing this origin for the sign-in client: the front door is shut.", [
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
            `     no-referrer is the bug, and it is ours: see _editor/web/nginx.conf.`,
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

    // Must never go missing: some ways the Google button fails are invisible to the page itself.
    const escape = await page.getByText(/Google's own page/i).count();
    if (escape === 0) {
        fail("The sign-in page offers no fallback way in.", [
            "",
            "Some ways Google's button can fail are invisible to the page, so the link that",
            "bypasses it has to be there unconditionally (see Login.vue).",
        ]);
    }

    if (process.exitCode !== 1) {
        console.log(`sign-in smoke OK: Google's button is live on ${loginUrl}, and the fallback link is there.`);
    }
} catch (error) {
    fail(`the sign-in page did not load: ${error instanceof Error ? error.message : String(error)}`);
} finally {
    await browser.close();
}
