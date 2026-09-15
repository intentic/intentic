#!/usr/bin/env node
// This browser smoke is the only gate that exercises Google's real origin check instead of seeded or mocked auth.
// A valid page needs both a sized Google iframe and an independent redirect control.

import { chromium } from "@playwright/test";

const origin = (process.argv[2] ?? process.env.WEB_ORIGIN ?? "https://app.intentic.dev").replace(/\/+$/, "");
const loginUrl = `${origin}/login`;

// Generous: this runs seconds after deploy, before the container, Google's script and its frame have warmed up.
const BUTTON_DEADLINE_MS = 30_000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

// Exact string Google Identity Services logs when the OAuth client refuses this page's origin.
const ORIGIN_REFUSED = /origin is not allowed for the given client/i;
const TRANSIENT_NETWORK =
    /ERR_(?:CONNECTION_(?:CLOSED|REFUSED|RESET|TIMED_OUT)|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|TIMED_OUT)|failed to fetch|network\s*error/i;

const fail = (message, detail) => {
    console.error(`\nsign-in smoke FAILED against ${loginUrl}`);
    console.error(`  ${message}`);
    for (const line of detail ?? []) {
        console.error(`  ${line}`);
    }
    process.exitCode = 1;
};

const inspect = async (browser) => {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
        if (message.type() === "error") {
            consoleErrors.push(message.text());
        }
    });

    try {
        const navigation = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: BUTTON_DEADLINE_MS });
        // Every check below reads the app out of this response, so a status that is not 200 makes all of them
        // say the app is broken. 0 stands for a navigation that produced no response at all.
        const status = navigation?.status() ?? 0;
        const csp = navigation?.headers()["content-security-policy"] ?? "";
        const frameSources = /(?:^|;)\s*frame-src\s+([^;]*)/.exec(csp)?.[1].trim().split(/\s+/) ?? [];
        const previewFramesAllowed = frameSources.includes("https:");
        // Straight back out, so a retryable status costs the delay and not the button deadline three times over.
        if (status !== 200) {
            return { consoleErrors, fallback: 0, loadError: undefined, pressable: false, previewFramesAllowed, refused: [], status };
        }

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
        const fallback = await page.getByRole("button", { name: /Trouble signing in|Continue with Google/i }).count();
        return { consoleErrors, fallback, loadError: undefined, pressable, previewFramesAllowed, refused, status };
    } catch (error) {
        return {
            consoleErrors,
            fallback: 0,
            loadError: error instanceof Error ? error.message : String(error),
            pressable: false,
            previewFramesAllowed: false,
            refused: [],
            status: 0,
        };
    } finally {
        await page.close();
    }
};

// Full chromium, not the headless shell: the smoke must use the browser a visitor gets.
const browser = await chromium.launch({ channel: "chromium" });

try {
    let result;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
        result = await inspect(browser);
        const transportErrors = [...result.consoleErrors, result.loadError ?? ``].filter((text) => TRANSIENT_NETWORK.test(text));
        // A status that is not 200 is retried like a transport failure: the origin sits behind a tunnel whose
        // container the deploy before this step has just recreated.
        const retryable = transportErrors.length > 0 || (result.loadError === undefined && result.status !== 200);
        if (result.refused.length > 0 || result.pressable || !retryable || attempt === RETRY_ATTEMPTS) {
            break;
        }
        console.warn(`sign-in smoke attempt ${attempt}/${RETRY_ATTEMPTS} did not reach the app; retrying in ${RETRY_DELAY_MS / 1000}s.`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    if (result.loadError !== undefined) {
        fail(`the sign-in page did not load: ${result.loadError}`);
    } else if (result.status !== 200) {
        // Before every page check, because a page that was never served cannot be judged by them.
        fail(`the origin answered ${result.status === 0 ? "nothing" : result.status}, so the app was never served.`, [
            "",
            "Nothing about this page's code is implicated: no Content-Security-Policy, no bundle, no button.",
            "The web container is not up, or the tunnel in front of it has no origin to reach —",
            "deploy-platform.sh waits for the public origin to report the build it pushed (X-Web-Build),",
            "so a status here means the container went away again after that check.",
        ]);
    } else if (!result.previewFramesAllowed) {
        fail("The editor's Content-Security-Policy refuses secure preview frames.", [
            "",
            "The frame-src directive must include https: so sandbox and user-selected preview origins can load.",
            "Check _editor/web/nginx.conf and the response served by the deployed web image.",
        ]);
    } else if (result.refused.length > 0) {
        fail("Google is refusing this origin for the sign-in client: the front door is shut.", [
            "",
            `Google said: ${result.refused[0]}`,
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
    } else if (!result.pressable) {
        fail("Google's sign-in button never became pressable (it stayed zero-sized).", [
            "",
            "Nothing named a cause, so the usual suspects are: the Identity Services script never",
            "loaded, or the page rendered it into a container that is hidden.",
            ...(result.consoleErrors.length > 0
                ? ["", "Console errors seen:", ...result.consoleErrors.slice(0, 5).map((text) => `  - ${text}`)]
                : []),
        ]);
    }

    // The page must expose either its escape link or the primary redirect button without Google's iframe.
    // Gated on a served page like the chain above, since an error page has no controls of ours to be missing.
    if (result.loadError === undefined && result.status === 200 && result.fallback === 0) {
        fail("The sign-in page offers no fallback way in.", [
            "",
            "Some Google failures are invisible to the page, so a redirect control that",
            "bypasses the embedded button has to remain available (see Login.vue).",
        ]);
    }

    if (process.exitCode !== 1) {
        console.log(`sign-in smoke OK: Google's button is live on ${loginUrl}, secure previews are admitted, and the fallback control is there.`);
    }
} finally {
    await browser.close();
}
