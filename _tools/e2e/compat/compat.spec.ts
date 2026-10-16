import { PrismaClient } from "@intentic/prisma";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { type BrowserContext, expect, type Page, type Request, test } from "@playwright/test";
import { PrismaPg } from "@prisma/adapter-pg";
import { GOOGLE_BUTTON, newPerson, type Person, signInToGoogle } from "../signin/google.js";
import { ENV_GOOGLE_KEY, stackDatabase, stackUrls } from "../signin/tier.js";
import { type DaemonUnderTest, daemonUnderTest } from "./compat-tier.js";

// TODAY'S EDITOR AGAINST THE SANDBOX OWNERS RUN. A person signs in to this commit's web build, is given a sandbox served
// by the released daemon (a row on the platform pointing at it, as `ic sandbox connect` leaves one), and opens the pages
// most of a day is spent on: the agent board, the files, a chat, and the Sandbox page. Each must draw with nothing
// failing on the way: no call the daemon refused, no read that failed, no uncaught error, and not the "too old" page,
// which would mean the release owners run is below the floor this editor supports (OLDEST_SUPPORTED_DAEMON).
//
// What it does not do is use them: a turn needs a model, and a written file proves nothing a read does not. Its claim is
// the one the deploy needs: the editor that is about to ship opens on the sandboxes that are already out there.

const SANDBOX_ID = `compat-sandbox`;
const SANDBOX_NAME = `Released sandbox`;

// The pages, and what each has to show before it counts as drawn: the board's cards and buttons, the files' tabs, a
// chat's box to type in, the Sandbox page under the sandbox's own name. Read off the page's structure and the seeded
// name rather than its words, so a reworded label does not fail a check about versions.
const PAGES: readonly { readonly path: string; readonly drawn: (page: Page) => Promise<void> }[] = [
    { path: `/agents`, drawn: (page) => expect(page.locator(`main`).getByRole(`button`).first()).toBeVisible() },
    { path: `/workspace`, drawn: (page) => expect(page.locator(`main`).getByRole(`tablist`).first()).toBeVisible() },
    { path: `/chat`, drawn: (page) => expect(page.locator(`main`).getByRole(`textbox`).first()).toBeVisible() },
    { path: `/sandbox/overview`, drawn: (page) => expect(page.locator(`main`).getByRole(`heading`, { level: 1, name: SANDBOX_NAME })).toBeVisible() },
];

// How long the daemon's traffic must stay quiet before a page counts as settled. Its /events stream never ends and is
// not counted; everything else a page asks on arrival has answered by then.
const QUIET_MS = 2_000;

const googleKey = (): string => {
    const key = process.env[ENV_GOOGLE_KEY];
    if (key === undefined) {
        throw new Error(`the sign-in stack's Google key is missing: run this through compat.playwright.config.ts`);
    }
    return key;
};

// The platform's row for the person's sandbox, as connecting one leaves it: owned by them, seen, and addressed at the
// daemon under test. The connect token is the daemon's own, so its /health names the id the editor checks for.
const giveSandbox = async (person: Person, daemon: DaemonUnderTest): Promise<void> => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: stackDatabase() }) });
    try {
        const owner = await prisma.user.findUniqueOrThrow({ where: { email: person.email } });
        await prisma.sandbox.create({
            data: {
                id: SANDBOX_ID,
                name: SANDBOX_NAME,
                ownerId: owner.id,
                token: daemon.connectToken,
                tokenDigest: sha256Hex(daemon.connectToken),
                tunnelId: sandboxIdFromToken(daemon.connectToken) ?? ``,
                daemonUrl: daemon.url,
                lastSeenAt: new Date(),
            },
        });
    } finally {
        await prisma.$disconnect();
    }
};

interface Watch {
    // Everything that went wrong, each in one line, for the assertion to print whole.
    readonly troubles: string[];
    // How many /events streams the daemon has answered: the connection every read the editor makes waits on. Each page
    // load opens its own.
    readonly streams: () => number;
    // Whether the daemon's traffic, the stream aside, has been quiet for QUIET_MS.
    readonly settled: () => boolean;
    // How many calls reached the daemon, so a run that asked it nothing cannot pass as one where nothing failed.
    readonly calls: () => number;
}

// What a page did against the daemon and in itself, from the moment this is called.
const watch = (page: Page, daemon: DaemonUnderTest): Watch => {
    const troubles: string[] = [];
    const open = new Set<Request>();
    let lastHeard = Date.now();
    let streams = 0;
    let calls = 0;
    const ours = (request: Request): boolean => request.url().startsWith(daemon.url);
    const named = (request: Request): string => `${request.method()} ${new URL(request.url()).pathname}`;
    page.on(`request`, (request) => {
        if (ours(request)) {
            open.add(request);
            calls += 1;
            lastHeard = Date.now();
        }
    });
    page.on(`response`, (response) => {
        const request = response.request();
        if (!ours(request)) {
            return;
        }
        // A stream answers its headers and stays open for as long as the page does; it is not traffic still owed.
        if ((response.headers()[`content-type`] ?? ``).includes(`text/event-stream`)) {
            open.delete(request);
            streams += response.ok() && new URL(request.url()).pathname.endsWith(`/events`) ? 1 : 0;
        }
        if (response.status() >= 400) {
            troubles.push(`${named(request)} answered ${response.status()}`);
        }
    });
    const done = (request: Request): void => {
        open.delete(request);
        lastHeard = Date.now();
    };
    page.on(`requestfinished`, done);
    page.on(`requestfailed`, (request) => {
        done(request);
        // A navigation cancels what the page it left was still asking; that is the browser, not the daemon.
        const failure = request.failure()?.errorText ?? ``;
        if (ours(request) && !failure.includes(`ERR_ABORTED`)) {
            troubles.push(`${named(request)} failed: ${failure}`);
        }
    });
    page.on(`console`, (message) => {
        // Every read that finally failed is logged by the editor's query cache as `query <key> failed`.
        if (/^query .* failed/u.test(message.text())) {
            troubles.push(message.text());
        }
    });
    page.on(`pageerror`, (error) => troubles.push(`uncaught: ${error.message}`));
    return { troubles, streams: () => streams, settled: () => open.size === 0 && Date.now() - lastHeard >= QUIET_MS, calls: () => calls };
};

const signIn = async (context: BrowserContext, person: Person): Promise<Page> => {
    await signInToGoogle(context, person, googleKey());
    const page = await context.newPage();
    await page.goto(`${stackUrls().web}/login`);
    await page.getByRole(`button`, { name: GOOGLE_BUTTON }).click();
    await expect(page).not.toHaveURL(/\/login(?:[?#]|$)/u);
    return page;
};

// The sandbox's own sign-in, as an earlier one leaves it: the session the editor keeps per sandbox in this browser
// (sandboxSession.ts, `intentic.session.<id>`). The daemon runs with its auth off, so the token is never checked; what is
// spared is the exchange (`POST /system/session`), which a daemon that verifies nobody refuses, and which the sign-in
// tier and the daemon's own suites cover. Far enough out that the editor never asks to renew it.
const SESSION_DAYS = 30;
const keepSandboxSession = async (context: BrowserContext, person: Person): Promise<void> => {
    await context.addInitScript(
        ({ key, session }) => localStorage.setItem(key, JSON.stringify(session)),
        { key: `intentic.session.${SANDBOX_ID}`, session: { token: `compat`, expiresAt: Date.now() + SESSION_DAYS * 86_400_000, email: person.email } },
    );
};

test(`today's editor opens its main pages on the released sandbox with nothing failing`, async ({ browser }) => {
    const daemon = daemonUnderTest();
    test.info().annotations.push({ type: `daemon`, description: `${daemon.version} at ${daemon.url}` });
    const person = newPerson(`compat`);
    const context = await browser.newContext({ locale: `en-US`, viewport: { width: 1280, height: 800 } });
    const page = await signIn(context, person);
    await giveSandbox(person, daemon);
    await keepSandboxSession(context, person);

    const seen = watch(page, daemon);
    for (const { path, drawn } of PAGES) {
        await test.step(path, async () => {
            const before = seen.streams();
            // Named on every visit: signing in left the account a setup row of its own (the wizard's), which a bare
            // visit would open instead. The editor selects the named one and drops the key from the address.
            await page.goto(`${stackUrls().web}${path}?sandbox=${SANDBOX_ID}`);
            await expect.poll(seen.streams, { message: `the editor never opened the daemon's /events stream on ${path}` }).toBeGreaterThan(before);
            // Below the floor the editor draws one page instead of any of these, and the release owners run must never
            // be. Waited for beside the quiet, since a daemon that old never goes quiet: with no roster revision on its
            // heartbeats, the editor reads its whole roster again every two seconds (daemon-floor.ts says so).
            const tooOld = page.locator(`[data-too-old]`);
            const outcome = async (): Promise<string> => ((await tooOld.count()) > 0 ? `too old` : seen.settled() ? `settled` : `busy`);
            // The sample that ended the wait is the one judged: a second look reads another moment, and a page's next
            // refetch landing right after the quiet window read as `busy` and failed as "too old" (run 38919885439).
            let ended = `busy`;
            await expect
                .poll(async () => (ended = await outcome()), { message: `the daemon's traffic never went quiet on ${path}`, timeout: 60_000 })
                .not.toBe(`busy`);
            expect(ended, `the editor calls ${daemon.version} too old for it`).toBe(`settled`);
            // Nor any other gate (connecting, warming, refused): the page itself, drawn.
            await expect(page.locator(`[data-sandbox-gate]`)).toHaveCount(0);
            await drawn(page);
        });
    }
    expect(seen.troubles, `what went wrong against ${daemon.version}`).toEqual([]);
    expect(seen.calls(), `calls the pages made to the daemon`).toBeGreaterThan(PAGES.length * 4);
    await context.close();
});
