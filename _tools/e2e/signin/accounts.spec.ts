import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homePath, page as pages } from "@intentic/sandbox-contract/app-routes";
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { GOOGLE_BUTTON, newPerson, signedOutOfGoogle, signInToGoogle } from "./google.js";
import { ENV_GOOGLE_KEY, REPO, stackUrls } from "./tier.js";

// SEVERAL ACCOUNTS IN ONE BROWSER: a person signed in with one address adds another beside it (a company address and a
// personal one), switches between them from the rail's account menu, and signs out of one or of all. The platform keeps
// each as a device session (Better Auth's multi-session, _platform/api/src/device-sessions.ts) with one of them active,
// in a cookie every tab shares; the editor draws a page for exactly one account for its whole life
// (_editor/web/src/lib/accountBoundary.ts), so every move to another account is a full navigation to Home, every other
// tab follows it, each account's storage is a drawer of its own, and a call a page meant for one account never runs as
// another.
//
// The accounts sign in with a code mailed to an address on a domain of their own, as signin.spec.ts's email specs do,
// except where a Google credential is the thing kept apart. Each spec is a new browser with new people.

// The labels the specs find controls by, read from the editor's English catalogue so a reworded label moves with the page.
interface Labels {
    readonly shell: { readonly words: { readonly account: string } };
    readonly community: { readonly dot: string };
    readonly auth: { readonly emailSignIn: { readonly addressLabel: string; readonly continueWithEmail: string; readonly codeLabel: string } };
}
// SAFETY: the editor's own catalogue, nested objects of strings; a key gone from it reads as undefined, which the
// assertion below names before any spec runs.
const CATALOG = JSON.parse(readFileSync(join(REPO, `_editor/web/src/app/i18n/locales/en.json`), `utf8`)) as Labels;
const LABELS = {
    // The rail's avatar, which says so when the community's note waits in its menu (AccountPanel.vue `accountHint`).
    account: CATALOG.shell.words.account,
    accountWithNote: CATALOG.community.dot,
    emailAddress: CATALOG.auth.emailSignIn.addressLabel,
    continueWithEmail: CATALOG.auth.emailSignIn.continueWithEmail,
    signInCode: CATALOG.auth.emailSignIn.codeLabel,
};
for (const [name, label] of Object.entries(LABELS)) {
    if (label === undefined) {
        throw new Error(`en.json no longer has the label this spec finds its ${name} control by`);
    }
}

// The platform's words for which account a call is meant for, as they cross the wire (_shared/api-contract/src/device-accounts.ts).
const ACCOUNT_HEADER = `x-intentic-account`;
const ACCOUNT_CHANGED = `ACCOUNT_CHANGED`;
// Where the browser keeps each account's storage (@intentic/ui's browserStorage.ts): a drawer per account, its keys
// `intentic@<accountId>/<key>`, and a pointer saying which drawer a page opens.
const POINTER_KEY = `intentic.signedInAs`;
const GOOGLE_CREDENTIAL = /^(?:intentic@([^/]+)\/)?intentic\.gid\./u;

// Where every move to another account lands (client/auth/deviceAccounts.ts `ACCOUNT_HOME`, which the router sends Home).
const HOME = /\/home(?:[/?#]|$)/u;
// The account's settings, in Home's frame, where they need no sandbox.
const ACCOUNT_SETTINGS = homePath(undefined, pages.account());
const LOGIN = /\/login(?:[?#]|$)/u;

const googleKey = (): string => {
    const key = process.env[ENV_GOOGLE_KEY];
    if (key === undefined) {
        throw new Error(`the sign-in stack's Google key is missing: run this through signin.playwright.config.ts`);
    }
    return key;
};

// A context made by hand does not take the config's `use`, so the two things the specs lean on are said again. Each
// starts signed in to no Google account, served locally, so no page in it waits on the real Google (google.ts).
const freshBrowser = async (browser: Browser): Promise<BrowserContext> => {
    const context = await browser.newContext({ locale: `en-US`, viewport: { width: 1280, height: 800 } });
    await signedOutOfGoogle(context);
    return context;
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

/* WHAT THE PLATFORM SAYS, asked with the context's own cookies: who is active, and which accounts the browser holds. */

interface Account {
    readonly id: string;
    readonly email: string;
    readonly name: string;
}

interface DeviceSession {
    readonly session: { readonly token: string };
    readonly user: Account;
}

/** The account the browser's active session is, by the context's own cookies; undefined for nobody. */
const activeAccount = async (context: BrowserContext): Promise<Account | undefined> => {
    const response = await context.request.get(`${stackUrls().api}/api/auth/get-session`);
    // SAFETY: Better Auth's get-session answers `{ session, user }` or null; only the user's fields read here are used.
    const session = (await response.json().catch(() => null)) as { user?: Account } | null;
    return session?.user;
};

const signedInAs = async (context: BrowserContext): Promise<string | undefined> => (await activeAccount(context))?.email;

/** Every account signed in on this browser (multi-session's device sessions), the active one among them. */
const deviceSessions = async (context: BrowserContext): Promise<readonly DeviceSession[]> => {
    const response = await context.request.get(`${stackUrls().api}/api/auth/multi-session/list-device-sessions`);
    expect(response.ok(), `the platform must list the accounts this browser holds`).toBe(true);
    // SAFETY: list-device-sessions answers an array of `{ session, user }`, of which the fields above are read.
    return (await response.json()) as DeviceSession[];
};

const sessionOf = async (context: BrowserContext, email: string): Promise<DeviceSession> => {
    const found = (await deviceSessions(context)).find((entry) => entry.user.email === email);
    if (found === undefined) {
        throw new Error(`${email} is not signed in on this browser`);
    }
    return found;
};

const signedInHere = async (context: BrowserContext): Promise<readonly string[]> =>
    (await deviceSessions(context)).map((entry) => entry.user.email).toSorted();

/** A POST to the api from inside `page`, as its own scripts send one: from the page's origin, on the browser's cookies. */
const postFrom = (
    page: Page,
    path: string,
    body: object,
    headers: Readonly<Record<string, string>> = {},
): Promise<{ status: number; body: unknown }> =>
    page.evaluate(
        async (call) => {
            const response = await fetch(call.url, {
                method: `POST`,
                credentials: `include`,
                headers: { "content-type": `application/json`, ...call.headers },
                body: JSON.stringify(call.body),
            });
            const answer: unknown = await response.json().catch(() => null);
            return { status: response.status, body: answer };
        },
        { url: `${stackUrls().api}${path}`, body, headers },
    );

/* WHAT THE BROWSER KEEPS. */

const storageOf = (page: Page): Promise<Readonly<Record<string, string>>> => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));

/** The account whose drawer the browser opens; undefined for nobody's. */
const pointerOf = async (page: Page): Promise<string | undefined> => (await storageOf(page))[POINTER_KEY];

/** Every Google credential the browser keeps: the account whose drawer holds it (undefined: none, so any may read it) and whom it names. */
const googleCredentials = async (page: Page): Promise<readonly { readonly drawer: string | undefined; readonly email: string | undefined }[]> =>
    Object.entries(await storageOf(page)).flatMap(([key, token]) => {
        const match = GOOGLE_CREDENTIAL.exec(key);
        if (match === null) {
            return [];
        }
        // SAFETY: a Google ID token's payload, of which only the email claim is read.
        const claims = JSON.parse(Buffer.from(token.split(`.`)[1] ?? ``, `base64url`).toString(`utf8`)) as { email?: string };
        return [{ drawer: match[1], email: claims.email }];
    });

/* SIGNING IN BY CODE. The tier's api keeps what it would have handed Resend and serves the newest mail to an address
 * back (browser-api.ts `/__e2e/mail`), which is the inbox these specs read. */

// A person on a domain of their own, with no Google account behind the address.
const newEmailPerson = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@own-domain.e2e.intentic.dev`;

/** The code in the newest sign-in mail to `email`. Waits for it to arrive. */
const codeMailedTo = async (context: BrowserContext, email: string): Promise<string> => {
    const read = async (): Promise<string | undefined> => {
        const response = await context.request.get(`${stackUrls().api}/__e2e/mail?to=${encodeURIComponent(email)}`);
        if (!response.ok()) {
            return undefined;
        }
        // SAFETY: browser-api.ts answers this shape, the kept mail and the code read out of it.
        const mail = (await response.json()) as { code: string | null };
        return mail.code ?? undefined;
    };
    await expect.poll(read, { message: `the platform never mailed ${email} a sign-in code` }).toBeDefined();
    const code = await read();
    if (code === undefined) {
        throw new Error(`the mail to ${email} went away`);
    }
    return code;
};

/** Signs `email` in by the code mailed to it, on the sign-in screen the page is on, and waits for it to land Home. */
const enterCode = async (page: Page, email: string): Promise<void> => {
    await page.getByLabel(LABELS.emailAddress).fill(email);
    await page.getByRole(`button`, { name: LABELS.continueWithEmail }).click();
    const code = page.getByLabel(LABELS.signInCode);
    await expect(code).toBeVisible();
    // The sixth digit signs in by itself.
    await code.fill(await codeMailedTo(page.context(), email));
    await expect(page).toHaveURL(HOME);
    expect(await signedInAs(page.context())).toBe(email);
};

/** A new page in `context`, signed in as `email` by code on the web's own sign-in screen. */
const signInByCode = async (context: BrowserContext, email: string): Promise<Page> => {
    const page = await context.newPage();
    record(page, `web`);
    await page.goto(`${stackUrls().web}/login`);
    await enterCode(page, email);
    return page;
};

/* THE ACCOUNT MENU, at the foot of the rail (_editor/web/src/shell/AccountPanel.vue). */

const byTest = (scope: Page | Locator, name: string): Locator => scope.locator(`[data-test="${name}"]`);

/** Signing out beside another account asks which: this one (the dialog's accent button) or all of them (`sign-out-all`). */
const askedToSignOut = async (page: Page, menu: Locator): Promise<Locator> => {
    await byTest(menu, `sign-out`).click();
    const dialog = page.getByRole(`dialog`).filter({ has: byTest(page, `sign-out-all`) });
    await expect(dialog).toBeVisible();
    return dialog;
};

/** Opens the rail's account menu, pinned, and returns it; one already open is returned as it is. */
const openAccountMenu = async (page: Page): Promise<Locator> => {
    const menu = page.getByRole(`dialog`).filter({ has: byTest(page, `sign-out`) });
    if (!(await menu.isVisible())) {
        const avatar = page
            .getByRole(`button`, { name: LABELS.account, exact: true })
            .or(page.getByRole(`button`, { name: LABELS.accountWithNote, exact: true }));
        await avatar.and(page.locator(`[aria-haspopup="dialog"]`)).click();
    }
    await expect(menu).toBeVisible();
    return menu;
};

/** That the page is drawn for `email`: the account menu's head names it, and it is never among the other accounts. */
const expectMenuFor = async (page: Page, email: string): Promise<Locator> => {
    const menu = await openAccountMenu(page);
    await expect(menu.getByText(email, { exact: true }), `the account menu must name ${email} as the account in front of the reader`).toBeVisible();
    await expect(byTest(menu, `other-account`).filter({ hasText: email })).toHaveCount(0);
    return menu;
};

/** That the page landed Home as `email`: the platform's active session is theirs, and the page is drawn for them. */
const expectHomeAs = async (page: Page, email: string): Promise<Locator> => {
    await expect(page).toHaveURL(HOME);
    expect(await signedInAs(page.context())).toBe(email);
    return expectMenuFor(page, email);
};

/**
 * Presses something that moves the browser to another account (or to nobody), which the page leaves for by a full
 * navigation, and waits for the page it lands on. The address alone cannot tell: a switch from Home lands Home again.
 */
const pressToLeave = async (page: Page, control: Locator): Promise<void> => {
    const landed = page.waitForEvent(`load`);
    await control.click();
    await landed;
};

/** Adds `email` beside `current`, the account the page is drawn for, from the account menu; lands Home as `email`. */
const addAccountByCode = async (page: Page, email: string, current: string): Promise<void> => {
    const menu = await openAccountMenu(page);
    await byTest(menu, `add-account`).click();
    await expect(page).toHaveURL(/\/login\?add=1$/u);
    await expect(byTest(page, `add-title`)).toBeVisible();
    // The screen says who stays signed in while another is added, and its way back is to them.
    await expect(byTest(page, `add-back`)).toContainText(current);
    await enterCode(page, email);
};

/** Switches the page to `email`, another account signed in on this browser, from the account menu. */
const switchFromMenu = async (page: Page, email: string): Promise<void> => {
    const menu = await openAccountMenu(page);
    await pressToLeave(page, byTest(menu, `other-account`).filter({ hasText: email }));
    await expectHomeAs(page, email);
};

/** A new browser signed in to two new accounts by code: `first`, then `second` added beside it, the page drawn for `second`. */
const twoAccounts = async (browser: Browser, label: string): Promise<{ context: BrowserContext; page: Page; first: string; second: string }> => {
    const first = newEmailPerson(`${label}-first`);
    const second = newEmailPerson(`${label}-second`);
    const context = await freshBrowser(browser);
    const page = await signInByCode(context, first);
    await addAccountByCode(page, second, first);
    return { context, page, first, second };
};

test(`a person signed in with one address adds a second, and switches between the two from the account menu`, async ({ browser }) => {
    const first = newEmailPerson(`first`);
    const second = newEmailPerson(`second`);
    const context = await freshBrowser(browser);
    const page = await signInByCode(context, first);
    await expectHomeAs(page, first);
    const firstId = (await sessionOf(context, first)).user.id;
    expect(await pointerOf(page), `the browser must open the drawer of the account signed in`).toBe(firstId);

    await addAccountByCode(page, second, first);
    const menu = await expectHomeAs(page, second);
    // The first account is still signed in beside it, one press away.
    await expect(byTest(menu, `other-account`).filter({ hasText: first })).toBeVisible();
    await expect(byTest(menu, `other-account`)).toHaveCount(1);
    expect(await pointerOf(page)).toBe((await sessionOf(context, second)).user.id);
    expect(await signedInHere(context)).toEqual([first, second].toSorted());

    await switchFromMenu(page, first);
    expect(await pointerOf(page), `the browser's pointer must follow the switch`).toBe(firstId);
    // A switch signs nobody out.
    expect(await signedInHere(context)).toEqual([first, second].toSorted());
});

// The credential an account proves itself to its sandboxes with is the one account key every Google sign-in writes, so
// it is what shows the drawers kept apart: an account switched to must never present the other's Google identity.
test(`an account's Google credential stays in its own drawer, and the account switched to never holds it`, async ({ browser }) => {
    const person = newPerson(`drawer`);
    const added = newEmailPerson(`drawer`);
    const context = await freshBrowser(browser);
    await signInToGoogle(context, person, googleKey());
    const page = await context.newPage();
    record(page, `web`);
    await page.goto(`${stackUrls().web}/login`);
    await page.getByRole(`button`, { name: GOOGLE_BUTTON }).click();
    await expectHomeAs(page, person.email);
    const personId = (await sessionOf(context, person.email)).user.id;
    // Kept in the account's own drawer, and nowhere every account reads.
    const kept = [{ drawer: personId, email: person.email }];
    await expect
        .poll(() => googleCredentials(page), { message: `the Google sign-in must keep its credential in the account's drawer` })
        .toEqual(kept);

    await addAccountByCode(page, added, person.email);
    await expectHomeAs(page, added);
    expect(await pointerOf(page)).toBe((await sessionOf(context, added)).user.id);
    expect(await googleCredentials(page), `moving to another account must neither clear the first one's credential nor hand it over`).toEqual(kept);

    await switchFromMenu(page, person.email);
    expect(await pointerOf(page)).toBe(personId);
    expect(await googleCredentials(page)).toEqual(kept);
});

test(`a second tab follows when the first switches account, leaving for Home as the account switched to`, async ({ browser }) => {
    const { context, page, first, second } = await twoAccounts(browser, `tabs`);
    const settings = await context.newPage();
    record(settings, `second tab`);
    await settings.goto(`${stackUrls().web}${ACCOUNT_SETTINGS}`);
    await expect(settings).toHaveURL(new RegExp(`${ACCOUNT_SETTINGS}(?:[/?#]|$)`, `u`));
    await expectMenuFor(settings, second);

    await switchFromMenu(page, first);
    // Told by the first tab, and gone Home: Settings was drawn for the account the browser left, and a tab that only
    // noticed the switch on its own would have reloaded where it stood.
    await expectHomeAs(settings, first);
});

// The cookie is the browser's, not a page's: a tab still drawn for one account can send its next call on the session
// another tab moved to someone else. The page names the account it means on every call that changes something.
test(`a change a page asks for as one account is refused once the browser has moved to another under it`, async ({ browser }) => {
    const { context, page, first, second } = await twoAccounts(browser, `stale`);
    const [kept, drawnFor] = await Promise.all([sessionOf(context, first), sessionOf(context, second)]);

    // Another tab makes the first account active by the platform alone, so the page drawn for the second hears nothing.
    const tab = await context.newPage();
    record(tab, `other tab`);
    await tab.goto(`${stackUrls().web}${ACCOUNT_SETTINGS}`);
    expect(await postFrom(tab, `/api/auth/multi-session/set-active`, { sessionToken: kept.session.token })).toMatchObject({ status: 200 });
    expect(await signedInAs(context)).toBe(first);

    // Renaming "me", as the page still drawn for the second account, would rename the first.
    const renamed = await postFrom(page, `/api/auth/update-user`, { name: `X` }, { [ACCOUNT_HEADER]: drawnFor.user.id });
    expect(renamed).toMatchObject({ status: 409, body: { code: ACCOUNT_CHANGED } });
    expect((await activeAccount(context))?.name, `the refused rename must not have reached the account now active`).toBe(kept.user.name);
    expect((await sessionOf(context, second)).user.name).toBe(drawnFor.user.name);
});

test(`signing out of one account carries on as the other, and signing out of all of them leaves nobody signed in`, async ({ browser }) => {
    const { context, page, first, second } = await twoAccounts(browser, `sign-out`);
    const menu = await expectMenuFor(page, second);
    const asked = await askedToSignOut(page, menu);
    await pressToLeave(page, asked.getByRole(`button`, { name: `Sign out`, exact: true }));
    // On as the account still signed in, never to the sign-in screen.
    await expectHomeAs(page, first);
    expect(await signedInHere(context)).toEqual([first]);

    // "Sign out of all" is offered only beside another account, so a third joins first.
    const third = newEmailPerson(`sign-out-third`);
    await addAccountByCode(page, third, first);
    const thirdMenu = await expectHomeAs(page, third);
    const askedAgain = await askedToSignOut(page, thirdMenu);
    await pressToLeave(page, byTest(askedAgain, `sign-out-all`));
    await expect(page).toHaveURL(LOGIN);
    expect(await signedInAs(context)).toBeUndefined();
    expect(await signedInHere(context)).toEqual([]);
    // Nobody is left to continue as, and the browser opens nobody's drawer.
    await expect(page.getByLabel(LABELS.emailAddress)).toBeVisible();
    await expect(byTest(page, `continue-as`)).toHaveCount(0);
    expect(await pointerOf(page)).toBeUndefined();
    expect(Object.keys(await storageOf(page)).filter((key) => key.startsWith(`intentic@`))).toEqual([]);
});

test(`when the active account's sign-in ends elsewhere, the sign-in screen offers to continue as the one still signed in`, async ({ browser }) => {
    const { context, page, first, second } = await twoAccounts(browser, `continue`);
    // Signed out from another device: the session ends at the platform while this browser still holds its cookies, and
    // nobody's session is active here now.
    const ended = await sessionOf(context, second);
    expect(await postFrom(page, `/api/auth/revoke-session`, { token: ended.session.token })).toMatchObject({ status: 200 });
    await page.close();
    expect(await signedInAs(context)).toBeUndefined();

    const login = await context.newPage();
    record(login, `web`);
    await login.goto(`${stackUrls().web}/login`);
    const rows = byTest(byTest(login, `continue-as`), `continue-as-row`);
    await expect(rows.filter({ hasText: first })).toBeVisible();
    // The ended sign-in is not offered: continuing as it could only fail.
    await expect(rows).toHaveCount(1);
    await pressToLeave(login, rows.filter({ hasText: first }));
    await expectHomeAs(login, first);
});
