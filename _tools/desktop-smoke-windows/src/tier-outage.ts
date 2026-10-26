// Tier 5: what the installed app does when intentic is down, in the three shapes an outage takes (outage.ts says
// which and why). Every scenario is this launch's alone: the app's decision files pinned and put back (hermetic.ts
// `pinFiles`), a throwaway WebView2 profile (`WEBVIEW2_USER_DATA_FOLDER`), the Rust side's calls sent to a dead proxy,
// and the workspace's address played by a local stub, so nothing reaches intentic and no signed-in profile is read or
// written. `roster.json` is pinned absent too: a platform address the profile holds no session for reads as "nobody
// signed in", which the app writes into it.
// It needs the app installed (`install --keep-installed`) and quits any copy of it that runs: a running copy would take
// this tier's launch through the single-instance plugin and never see its environment.

import { errorMessage } from "@intentic/base/errors";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appExecutable, appRunning, launchApp, quitApp } from "./app.js";
import { APP_IDENTIFIER, PRODUCT_NAME } from "./constants.js";
import type { Harness } from "./harness.js";
import { listen, pinFiles, restore } from "./hermetic.js";
import {
    BROWSER_ARGS_SOURCE,
    browserArgsOf,
    browserArguments,
    DEAD_PROXY,
    describeRequests,
    isNavigation,
    offlineStatus,
    OUTAGE_APP_URL,
    OUTAGE_PLATFORM_URL,
    type OutageStub,
    pageAt,
    pageTargets,
    type PageTarget,
    startOutageStub,
    unresolvable,
} from "./outage.js";
import { appWindows, findInstalledApp } from "./probe.js";

export interface OutageTierOptions {
    /** A built editor (`_editor/web/dist`) to serve for the API-only scenario; without one that scenario is skipped. */
    readonly editorDist: string | undefined;
}

// A cold launch builds WebView2's profile from nothing, which is the slow part of a first page.
const PAGE_SECONDS = 60;
// The offline page checks every 5 s (offline.html `EVERY`): four of its rounds, so a page that goes back to an address
// still answering 530 is seen doing it.
const HOLD_SECONDS = 20;
// The editor's own session check gives the platform 10 s before it says it is unavailable (router/sessionGuard.ts).
const EDITOR_SECONDS = 90;

const hostOf = (url: string): string => new URL(url).host;

/** A loopback port nothing holds right now, for WebView2's debugging endpoint. */
const freePort = async (): Promise<number> => {
    const server = createServer();
    const port = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
};

/** What the webview holds now, from its DevTools listing; nothing while the endpoint does not answer. */
const pagesOn = async (port: number): Promise<readonly PageTarget[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) });
    return pageTargets(await response.text());
};

/** No pages: what a listing that did not answer is read as while a scenario watches. */
const NO_PAGES: readonly PageTarget[] = [];

const describePages = (pages: readonly PageTarget[]): string => (pages.length === 0 ? `(no pages)` : pages.map((page) => `- ${page.url}`).join(`\n`));

/** One scenario's launch: the URLs it pins, the WebView2 arguments it adds, and what it asserts while the app runs. */
interface Scenario {
    readonly title: string;
    readonly appUrl: string;
    readonly extraArgs: readonly string[];
    readonly assert: (watch: Watch) => Promise<void>;
}

/** What a scenario's assertions read the running app through. */
interface Watch {
    readonly harness: Harness;
    readonly pages: () => Promise<readonly PageTarget[]>;
}

interface Machine {
    readonly executable: string;
    readonly app: string;
    readonly configDir: string;
    readonly appArgs: string;
}

const ENV_KEYS = [`INTENTIC_DISABLE_UPDATE_CHECK`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `WEBVIEW2_USER_DATA_FOLDER`, `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`] as const;

const quit = async (harness: Harness, machine: Machine): Promise<void> => {
    await quitApp(machine.executable);
    await harness.untilTrue(20, `the app closed`, async () => (await appWindows(machine.app)).length === 0 && !(await appRunning(machine.executable)));
};

const runScenario = async (harness: Harness, machine: Machine, scenario: Scenario): Promise<void> => {
    harness.section(scenario.title);
    const profile = await mkdtemp(join(tmpdir(), `intentic-outage-webview-`));
    const port = await freePort();
    const restorePins = await pinFiles(
        machine.configDir,
        new Map([
            [`settings.json`, JSON.stringify({ appUrl: scenario.appUrl, platformUrl: OUTAGE_PLATFORM_URL }, undefined, 2)],
            [`last-face.json`, JSON.stringify(`workspace`)],
            [`hosts-sandboxes.json`, JSON.stringify(false)],
            [`resume-setup.json`, undefined],
            [`roster.json`, undefined],
        ]),
    );
    const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env[`INTENTIC_DISABLE_UPDATE_CHECK`] = `1`;
    process.env[`HTTPS_PROXY`] = DEAD_PROXY;
    process.env[`HTTP_PROXY`] = DEAD_PROXY;
    process.env[`NO_PROXY`] = `127.0.0.1,localhost,::1`;
    process.env[`WEBVIEW2_USER_DATA_FOLDER`] = profile;
    process.env[`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`] = browserArguments(machine.appArgs, [`--remote-debugging-port=${port}`, ...scenario.extraArgs]);
    try {
        const launch = await launchApp(machine.executable);
        if (launch.code !== 0) {
            harness.fail(`could not start the app`, `${launch.stdout}${launch.stderr}`);
            return;
        }
        // Both prove the scenario is the one staged: arguments the app's WebView2 never read would test nothing, and a
        // profile it never used would be the runner's own.
        const answered = await harness.untilTrue(PAGE_SECONDS, `WebView2 took the scenario's arguments (its debugging port answers)`, async () => {
            await pagesOn(port);
            return true;
        });
        await harness.untilTrue(30, `WebView2 ran in a throwaway profile`, async () => existsSync(profile) && (await readdir(profile)).length > 0);
        if (answered) {
            await scenario.assert({ harness, pages: async () => await pagesOn(port) });
        }
        if (await appRunning(machine.executable)) {
            harness.pass(`the app is still running`);
        } else {
            harness.fail(`the app exited during the scenario`);
        }
    } finally {
        await quit(harness, machine);
        for (const [key, value] of previous) {
            restore(key, value);
        }
        await restorePins();
        // WebView2 lets go of its profile a moment after its host process ends.
        await delay(2_000);
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 1_000 });
    }
};

/** Polls the listing until `holds`, recording one assertion and, on failure, what the webview held last. */
const untilPages = async (watch: Watch, seconds: number, description: string, holds: (pages: readonly PageTarget[]) => boolean): Promise<boolean> => {
    let last: readonly PageTarget[] = [];
    const held = await watch.harness.untilTrue(seconds, description, async () => {
        last = await watch.pages();
        return holds(last);
    });
    if (!held) {
        watch.harness.detail(describePages(last));
    }
    return held;
};

// S1: no name resolves, the app's or the platform's: the oldest road, and the one the face was built for.
const nothingAnswers: Scenario = {
    title: `intentic unreachable: no name resolves`,
    appUrl: OUTAGE_APP_URL,
    extraArgs: [unresolvable([hostOf(OUTAGE_APP_URL), hostOf(OUTAGE_PLATFORM_URL)])],
    assert: async (watch) => {
        await untilPages(watch, PAGE_SECONDS, `the workspace window put up the offline page, saying the name did not resolve`, (pages) => offlineStatus(pages) === `host-name-not-resolved`);
    },
};

// S2: the address answers, with Cloudflare's page for a host behind it that is down. The road that used to end on that
// page, and the one a dead platform host actually takes.
const errorPage = (stub: OutageStub): Scenario => ({
    title: `intentic's host down behind Cloudflare: the address answers 530`,
    appUrl: stub.origin,
    extraArgs: [unresolvable([hostOf(OUTAGE_PLATFORM_URL)])],
    assert: async (watch) => {
        const { harness } = watch;
        await harness.untilTrue(PAGE_SECONDS, `the workspace window asked the address for its page`, () => stub.navigations() >= 1);
        const shown = await untilPages(watch, PAGE_SECONDS, `the 530 put up the offline page (status http-530) rather than the error page`, (pages) => offlineStatus(pages) === `http-530`);
        if (!shown) {
            harness.detail(describeRequests(stub.requests()));
            return;
        }
        // Held, not bounced: the offline page must not load an address that still answers 530, which would put the error
        // page back up and send the window round again every few seconds.
        const loadsWhenShown = stub.navigations();
        let left: readonly PageTarget[] | undefined;
        for (let second = 0; second < HOLD_SECONDS; second += 1) {
            await delay(1_000);
            const pages = await watch.pages().catch(() => NO_PAGES);
            if (offlineStatus(pages) === undefined) {
                left = pages;
                break;
            }
        }
        const reloads = stub.navigations() - loadsWhenShown;
        if (left === undefined && reloads === 0) {
            harness.pass(`it stayed on the offline page for ${HOLD_SECONDS}s, without loading the 530 again`);
        } else {
            harness.fail(`the offline page went back to an address still answering 530 (${reloads} reload(s) in ${HOLD_SECONDS}s)`, left === undefined ? describeRequests(stub.requests()) : describePages(left));
        }
        const checks = stub.requests().filter((request) => !isNavigation(request) && !request.path.startsWith(`/__`)).length;
        harness.detail(`the address was checked ${checks} time(s) without a load while the offline page was up`);

        // Back: the moment the address answers, the window goes to it.
        stub.setMode({ kind: `ready` });
        await untilPages(watch, 45, `once the address answered, the window went back to the workspace`, (pages) => pageAt(pages, stub.origin) && offlineStatus(pages) === undefined);
        await harness.untilTrue(20, `the workspace page was told it runs in the desktop app`, () => stub.reports().some((report) => report.desktop));
        const offered = stub.reports().filter((report) => report.machineFace).length;
        if (offered === 0) {
            harness.pass(`no sandbox face was offered on a computer that hosts no sandboxes`);
        } else {
            harness.fail(`the page was told this computer's sandboxes are on offer, on a computer that hosts none`);
        }
    },
});

// S3: the editor loads and only the API is down. The editor says so itself, and the app leaves its page alone.
const apiDown = (stub: OutageStub): Scenario => ({
    title: `only the API down: the editor loads`,
    appUrl: stub.origin,
    extraArgs: [unresolvable([hostOf(OUTAGE_PLATFORM_URL)])],
    assert: async (watch) => {
        await untilPages(watch, PAGE_SECONDS, `the editor loaded from the address`, (pages) => pageAt(pages, stub.origin));
        const said = await untilPages(watch, EDITOR_SECONDS, `the editor said intentic is unavailable (/platform-unavailable)`, (pages) => pageAt(pages, stub.origin, `/platform-unavailable`));
        if (!said) {
            watch.harness.detail(describeRequests(stub.requests()));
        }
        const pages = await watch.pages();
        if (offlineStatus(pages) === undefined) {
            watch.harness.pass(`the app left the editor's page up rather than its own offline page`);
        } else {
            watch.harness.fail(`the app replaced an editor that loaded with its offline page`, describePages(pages));
        }
    },
});

/** The installed app, its config directory, and the WebView2 arguments its source says it passes. */
const findMachine = async (harness: Harness): Promise<Machine | undefined> => {
    const installed = await findInstalledApp(PRODUCT_NAME);
    if (installed === undefined) {
        harness.fail(`${PRODUCT_NAME} is not installed`, `This tier runs the installed app: run \`install --keep-installed\` first.`);
        return undefined;
    }
    const executable = await appExecutable(installed.installLocation);
    if (executable === undefined) {
        harness.fail(`no executable in ${installed.installLocation}`);
        return undefined;
    }
    const appData = process.env[`APPDATA`];
    if (appData === undefined || appData === ``) {
        harness.fail(`APPDATA is unavailable; the app's settings cannot be pinned`);
        return undefined;
    }
    let appArgs: string | undefined;
    try {
        appArgs = browserArgsOf(await readFile(BROWSER_ARGS_SOURCE, `utf8`));
    } catch (error) {
        harness.fail(`the app's WebView2 arguments could not be read from ${BROWSER_ARGS_SOURCE}`, errorMessage(error));
        return undefined;
    }
    if (appArgs === undefined) {
        harness.fail(`${BROWSER_ARGS_SOURCE} no longer declares BROWSER_ARGS as this tier reads it`, `outage.ts browserArgsOf needs to follow it.`);
        return undefined;
    }
    harness.pass(`the app's own WebView2 arguments: ${appArgs}`);
    return { executable, app: basename(executable, `.exe`), configDir: join(appData, APP_IDENTIFIER), appArgs };
};

export const runOutageTier = async (harness: Harness, options: OutageTierOptions): Promise<void> => {
    harness.section(`the installed app`);
    const machine = await findMachine(harness);
    if (machine === undefined) {
        return;
    }
    if (await appRunning(machine.executable)) {
        await quit(harness, machine);
    }

    await runScenario(harness, machine, nothingAnswers);

    const failing = await startOutageStub({ kind: `error`, status: 530 });
    try {
        await runScenario(harness, machine, errorPage(failing));
    } finally {
        await failing.close();
    }

    if (options.editorDist === undefined) {
        harness.section(`only the API down: skipped, no --editor-dist (a built _editor/web/dist) was given`);
        return;
    }
    if (!existsSync(join(options.editorDist, `index.html`))) {
        harness.fail(`no editor build at ${options.editorDist}`, `Expected an index.html there: build @intentic/web first.`);
        return;
    }
    const editor = await startOutageStub({ kind: `editor`, dist: options.editorDist, apiUrl: OUTAGE_PLATFORM_URL });
    try {
        await runScenario(harness, machine, apiDown(editor));
    } finally {
        await editor.close();
    }
};
