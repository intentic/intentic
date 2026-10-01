import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { becomeTheAppWebview, completePath, listenForDeepLinks, readAuthLink, startAttempt } from "./desktop.js";
import { GOOGLE_BUTTON, newPerson, type Person, signInToGoogle } from "./google.js";
import { ENV_GOOGLE_KEY, REPO, stackUrls } from "./tier.js";

// A person with no session signs in, every way the product lets one: on the web, and through the desktop app, whose
// sign-in crosses from its window to the browser and back. Each spec is a new person on a new browser, so nothing here
// passes because an earlier spec (or a seeded row) already signed someone in.
//
// "Signed in" is asked of the api, not read off the screen: the context's own cookie jar calls /api/auth/get-session,
// which is what every later request of that window rides on.

// The labels the specs find controls by, read from the editor's English catalogue so a reworded label moves with the page.
interface Labels {
    readonly auth: {
        readonly words: { readonly continueGoogleInBrowser: string };
        readonly desktopAuth: { readonly closeTab: string };
        readonly desktopAuthComplete: { readonly backToSignIn: string };
    };
}
// SAFETY: the editor's own catalogue, nested objects of strings; a key gone from it reads as undefined, which the
// assertion below names before any spec runs.
const EN = (JSON.parse(readFileSync(join(REPO, `_editor/web/src/app/i18n/locales/en.json`), `utf8`)) as Labels).auth;
const LABELS = {
    continueInBrowser: EN.words.continueGoogleInBrowser,
    closeTab: EN.desktopAuth.closeTab,
    backToSignIn: EN.desktopAuthComplete.backToSignIn,
};
for (const [name, label] of Object.entries(LABELS)) {
    if (typeof label !== `string`) {
        throw new Error(`en.json no longer has the label this spec finds its ${name} control by`);
    }
}

// Where the app points its window once the browser hands the sign-in back (auth.rs `complete_path`).
const LANDING = `/desktop-auth/complete`;

const googleKey = (): string => {
    const key = process.env[ENV_GOOGLE_KEY];
    if (key === undefined) {
        throw new Error(`the sign-in stack's Google key is missing: run this through signin.playwright.config.ts`);
    }
    return key;
};

// A context made by hand does not take the config's `use`, so the two things the specs lean on are said again.
const freshBrowser = (browser: Browser): Promise<BrowserContext> => browser.newContext({ locale: `en-US`, viewport: { width: 1280, height: 800 } });

/** Who the api says this context is signed in as, by the context's own cookies; undefined for nobody. */
const signedInAs = async (context: BrowserContext): Promise<string | undefined> => {
    const response = await context.request.get(`${stackUrls().api}/api/auth/get-session`);
    const session = (await response.json().catch(() => null)) as { user?: { email?: string } } | null;
    return session?.user?.email;
};

// What went wrong on a page, kept for the report: an uncaught error, or an api call the server failed.
const record = (page: Page, label: string): void => {
    page.on(`pageerror`, (error) => void test.info().attach(`${label}: uncaught`, { body: String(error.stack ?? error), contentType: `text/plain` }));
    page.on(`response`, (response) => {
        if (response.url().startsWith(stackUrls().api) && response.status() >= 500) {
            void test.info().attach(`${label}: ${response.status()} ${response.url()}`, { body: response.statusText(), contentType: `text/plain` });
        }
    });
};

/** The web's own sign-in, which is also how a browser comes to hold a session before a desktop sign-in borrows it. */
const signInOnTheWeb = async (context: BrowserContext, person: Person): Promise<void> => {
    const page = await context.newPage();
    record(page, `web`);
    await page.goto(`${stackUrls().web}/login`);
    await page.getByRole(`button`, { name: GOOGLE_BUTTON }).click();
    await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/u);
    expect(await signedInAs(context)).toBe(person.email);
    await page.close();
};

/**
 * Where the app's window got to after the landing: `left` once the page has moved on (the sign-in finished), or what
 * the failure frame says when the page stopped there. Waits while it is still working.
 */
const landingOutcome = async (window: Page): Promise<string> => {
    const stopped = window.getByRole(`button`, { name: LABELS.backToSignIn });
    const outcome = async (): Promise<string> => {
        if (await stopped.isVisible()) {
            return `stopped on the landing: ${(await window.locator(`main`).innerText()).replaceAll(/\s+/gu, ` `).trim()}`;
        }
        return new URL(window.url()).pathname === LANDING ? `working` : `left`;
    };
    await expect.poll(outcome, { timeout: 30_000 }).not.toBe(`working`);
    return outcome();
};

interface DesktopSignIn {
    readonly person: Person;
    readonly webview: BrowserContext;
    readonly window: Page;
    readonly landing: string;
}

/**
 * The desktop app's sign-in end to end. The app's window (a context wearing `__INTENTIC_DESKTOP__`) asks to sign in;
 * the app opens the browser at its `/desktop-auth` page; the browser signs in and hands back `intentic://auth`; the app
 * points its window at the landing, which redeems the handoff into the window's own session. `before` runs in the app's
 * window first, for a spec about what the window was doing when sign-in was asked for; `browser` is the person's
 * browser, signed in already or not.
 */
const signInThroughTheApp = async (
    browser: Browser,
    options: { readonly person: Person; readonly personsBrowser: BrowserContext; readonly pressGoogle: boolean; readonly before?: (window: Page) => Promise<void> },
): Promise<DesktopSignIn> => {
    const { web } = stackUrls();
    const webview = await freshBrowser(browser);
    await becomeTheAppWebview(webview);
    const window = await webview.newPage();
    record(window, `app window`);
    const appHears = await listenForDeepLinks(window);

    await options.before?.(window);
    // Signed out, the window's every screen leads to /login, whose one action in the app is the browser hand-off.
    await window.goto(`${web}/`);
    await expect(window).toHaveURL(/\/login/u);
    await window.getByRole(`button`, { name: LABELS.continueInBrowser }).click();
    await appHears.next(`intentic://signin`);

    // auth.rs `start`: the app opens its page in the person's browser.
    const attempt = startAttempt();
    const tab = await options.personsBrowser.newPage();
    record(tab, `browser`);
    const browserSends = await listenForDeepLinks(tab);
    await tab.goto(`${web}${attempt.path}`);
    if (options.pressGoogle) {
        await tab.getByRole(`button`, { name: GOOGLE_BUTTON }).click();
    }
    const link = readAuthLink(await browserSends.next(`intentic://auth`));
    expect(link, `the browser's link back to the app must carry a handoff and the app's state`).toBeDefined();
    expect(link?.state, `the browser must echo the app's own state, or auth.rs drops the handoff`).toBe(attempt.state);
    await expect(tab.getByText(LABELS.closeTab)).toBeVisible();

    // auth.rs `complete`: the state matched, so the app points its window at the landing with the verifier it kept.
    const landing = completePath(link?.handoff ?? ``, attempt.verifier, link?.profile);
    await window.goto(`${web}${landing}`);
    return { person: options.person, webview, window, landing };
};

test(`a person signs in on the web with Google`, async ({ browser }) => {
    const person = newPerson(`web`);
    const context = await freshBrowser(browser);
    await signInToGoogle(context, person, googleKey());
    expect(await signedInAs(context)).toBeUndefined();

    await signInOnTheWeb(context, person);
});

test(`a person signs in to the desktop app through a browser that was signed out`, async ({ browser }) => {
    const person = newPerson(`desktop`);
    const personsBrowser = await freshBrowser(browser);
    await signInToGoogle(personsBrowser, person, googleKey());

    const { webview, window, landing } = await signInThroughTheApp(browser, { person, personsBrowser, pressGoogle: true });

    expect(await landingOutcome(window)).toBe(`left`);
    expect(await signedInAs(webview), `the app's window must hold its own session after the landing`).toBe(person.email);
    // The Google credential crossed with the session, so the window's first sandbox call needs no sign-in of its own.
    const credentialFor = await window.evaluate(() =>
        Object.entries(localStorage)
            .filter(([key]) => key.startsWith(`intentic.gid.`))
            .map(([, token]) => JSON.parse(atob((token.split(`.`)[1] ?? ``).replaceAll(`-`, `+`).replaceAll(`_`, `/`))).email as string),
    );
    expect(credentialFor, `the Google credential must be adopted into the app's window`).toContain(person.email);

    // The handoff is single use: the same landing, opened again by anyone, signs nobody in.
    const replay = await freshBrowser(browser);
    const replayed = await replay.newPage();
    await replayed.goto(`${stackUrls().web}${landing}`);
    expect(await landingOutcome(replayed)).toMatch(/^stopped on the landing/u);
    expect(await signedInAs(replay)).toBeUndefined();
});

test(`a person signs in to the desktop app through a browser already signed in, without pressing anything`, async ({ browser }) => {
    const person = newPerson(`desktop-returning`);
    const personsBrowser = await freshBrowser(browser);
    await signInToGoogle(personsBrowser, person, googleKey());
    await signInOnTheWeb(personsBrowser, person);

    // No press: the browser's own session and the credential it already holds answer the app's page by themselves.
    const { webview, window } = await signInThroughTheApp(browser, { person, personsBrowser, pressGoogle: false });

    expect(await landingOutcome(window)).toBe(`left`);
    expect(await signedInAs(webview)).toBe(person.email);
});

/* 1.318.0: "Ask an agent about this" on a file opens the app's window at `/?handoff=<file>`, and the sign-in it then
 * asks for lands at `/desktop-auth/complete?handoff=<sign-in>`. The router's guard for the first took the second's
 * `handoff` too, and every desktop sign-in stopped on "This sign-in link is incomplete". */
test(`a person who asked an agent about a file before signing in still signs in, and the file still waits`, async ({ browser }) => {
    const person = newPerson(`ask-agent`);
    const personsBrowser = await freshBrowser(browser);
    await signInToGoogle(personsBrowser, person, googleKey());
    // The link the app writes (local.rs): base64url of the file on its loopback server, its one-file bearer, its name.
    const file = { url: `http://127.0.0.1:47999/workspace/raw?path=Budget.xlsx`, token: `a`.repeat(40), name: `Budget.xlsx` };
    const askAgent = `/?handoff=${Buffer.from(JSON.stringify(file)).toString(`base64url`)}`;

    const { webview, window } = await signInThroughTheApp(browser, {
        person,
        personsBrowser,
        pressGoogle: true,
        before: async (appWindow) => {
            await appWindow.goto(`${stackUrls().web}${askAgent}`);
            // Taken out of the address before anything else reads it, and kept for the chat.
            await expect(appWindow).not.toHaveURL(/handoff=/u);
        },
    });

    expect(await landingOutcome(window)).toBe(`left`);
    expect(await signedInAs(webview)).toBe(person.email);
    // Still kept: no sandbox answers here, so no chat has taken it, and the sign-in must not have dropped it either.
    const waiting = await window.evaluate(() => sessionStorage.getItem(`intentic.localHandoff`));
    expect(waiting, `the file asked about before signing in must still be waiting for its chat`).toContain(file.name);
});
