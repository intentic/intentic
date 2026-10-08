import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { z } from "zod";
import { ensureDisplay, releaseDisplay } from "../cast/display.js";
import type { BrowserFingerprint } from "./fingerprint.js";
import { isOwnerWindow, launchOwnerBrowser, OWNER_WINDOW_FLAG, type OwnerBrowser, seedPreferences } from "./owner-browser.js";

// The owner's sign-in window as the route starts it: a plain Chromium process that Playwright attaches to. Checks
// that what a launch used to set by CDP emulation (clock, language, Accept-Language) now comes from the process,
// and that closing it keeps what the owner signed in with.

const playwright = await import("playwright").catch(() => undefined);
const installed = playwright !== undefined && existsSync(playwright.chromium.executablePath());

const device: BrowserFingerprint = {
    webglVendor: "Google Inc. (Intel)",
    webglRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    languages: ["de-DE", "de", "en"],
};

const DISPLAY_KEY = "owner-browser-test";
let server: Server;
let origin: string;
const headers: string[] = [];

beforeAll(async () => {
    server = createServer((request, response) => {
        headers.push(request.headers["accept-language"] ?? "");
        response.setHeader("content-type", "text/html");
        response.end("<html><body>ok</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
    server.close();
    releaseDisplay(DISPLAY_KEY);
});

const launch = async (userDataDir: string): Promise<OwnerBrowser> => {
    if (playwright === undefined) {
        throw new Error("unreachable: guarded by skipIf");
    }
    const display = await ensureDisplay(DISPLAY_KEY);
    return launchOwnerBrowser(playwright, {
        executablePath: playwright.chromium.executablePath(),
        userDataDir,
        display: display.name,
        fingerprint: device,
        windowArgs: [],
    });
};

test.skipIf(!installed)("the clock and languages are the process's own, not emulated", async () => {
    const browser = await launch(mkdtempSync(join(tmpdir(), "owner-browser-")));
    try {
        const page = browser.context.pages()[0] ?? (await browser.context.newPage());
        await page.goto(`${origin}/`);
        const seen = await page.evaluate(() => ({
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
            language: navigator.language,
            languages: [...navigator.languages],
            webdriver: navigator.webdriver,
        }));
        // Chromium of this version reports one language to pages, however many the profile lists, and resolves de_DE to
        // its own "de" pack for Intl, as it does on a German desktop; what matters is that both come from the browser.
        expect(seen).toEqual({ timeZone: "Europe/Berlin", intlLocale: "de", language: "de-DE", languages: ["de-DE"], webdriver: false });
        expect(headers.at(-1)?.split(",")[0]).toBe("de-DE");
    } finally {
        await browser.close();
    }
}, 60_000);

test.skipIf(!installed)("a cookie set before closing is there on the next launch", async () => {
    const profile = mkdtempSync(join(tmpdir(), "owner-browser-"));
    const first = await launch(profile);
    try {
        await first.context.addCookies([{ name: "session", value: "kept", url: origin, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    } finally {
        await first.close();
    }
    const second = await launch(profile);
    try {
        const cookies = await second.context.cookies(origin);
        expect(cookies.find((cookie) => cookie.name === "session")?.value).toBe("kept");
    } finally {
        await second.close();
    }
}, 90_000);

// A daemon that crashed left its window running on the profile; the next window must still open, not exit on
// finding the profile held. The first browser is never closed here, as a crash would never close it.
test.skipIf(!installed)("a window a crashed daemon left behind does not hold the profile against the next", async () => {
    const profile = mkdtempSync(join(tmpdir(), "owner-browser-"));
    await launch(profile);
    const second = await launch(profile);
    try {
        const page = second.context.pages()[0] ?? (await second.context.newPage());
        await page.goto(`${origin}/`);
        expect(await page.evaluate(() => document.body.textContent)).toBe("ok");
    } finally {
        await second.close();
    }
}, 90_000);

test("only the marked browser process on that profile counts as an owner's window", () => {
    const profile = `${WORKSPACE_ROOT}/${STATE_DIR}/local/browser/x`;
    const browser = [OWNER_WINDOW_FLAG, "--no-sandbox", `--user-data-dir=${profile}`, "about:blank"];
    expect(isOwnerWindow(browser, profile)).toBe(true);
    // A renderer of that browser, the agent's own browser on the same profile, and a window on another profile.
    expect(isOwnerWindow([...browser, "--type=renderer"], profile)).toBe(false);
    expect(isOwnerWindow(["--remote-debugging-port=41000", `--user-data-dir=${profile}`], profile)).toBe(false);
    expect(isOwnerWindow(browser, "/work/.intentic/local/browser/y")).toBe(false);
});

// What a window's profile holds before Chromium starts on it: the fingerprint's languages, and no translate offer to
// cover the picture. Whatever else the person set stays theirs.

const profiles: string[] = [];
afterAll(() => {
    for (const dir of profiles) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A profile directory, with a Preferences file holding `prefs` written as given (a string is written raw).
const profileWith = (raw?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "owner-prefs-"));
    profiles.push(dir);
    if (raw !== undefined) {
        mkdirSync(join(dir, "Default"), { recursive: true });
        writeFileSync(join(dir, "Default", "Preferences"), raw);
    }
    return dir;
};

const preferencesOf = (dir: string) => z.looseObject({}).parse(JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8")));

test("a fresh profile gets the languages and no translate offer", async () => {
    const fresh = profileWith();
    await seedPreferences(fresh, ["pl-PL", "pl", "en"]);
    expect(preferencesOf(fresh)).toEqual({
        intl: { accept_languages: "pl-PL,pl,en", selected_languages: "pl-PL,pl,en" },
        translate: { enabled: false },
    });
});

test("a used profile keeps everything the person set beside them", async () => {
    const used = profileWith(JSON.stringify({ intl: { accept_languages: "en", other: 1 }, translate: { enabled: true, keep: "x" }, session: { restore_on_startup: 1 } }));
    await seedPreferences(used, ["en-US", "en"]);
    expect(preferencesOf(used)).toEqual({
        intl: { accept_languages: "en-US,en", selected_languages: "en-US,en", other: 1 },
        translate: { enabled: false, keep: "x" },
        session: { restore_on_startup: 1 },
    });
});

test("a Preferences file it cannot read is left for Chromium", async () => {
    for (const raw of ["{not json", JSON.stringify({ intl: "not a section" })]) {
        const broken = profileWith(raw);
        // oxlint-disable-next-line eslint/no-await-in-loop -- two files, one at a time
        await seedPreferences(broken, ["en"]);
        expect(readFileSync(join(broken, "Default", "Preferences"), "utf8")).toBe(raw);
    }
});
