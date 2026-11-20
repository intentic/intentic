import { sleep } from "@intentic/base/async";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, type CDPSession, chromium, type Page } from "playwright";
import type { Daemon, Region } from "./daemon.js";
import { processesWithArg, readStat } from "./proc.js";

// The workload's side of a run: an X display of its own and a headful Chromium on it, laid out the way a sandbox lays
// out a browser window, with the viewport cropped out as the picture.
//
// - `daemon` (today): Xvfb at the daemon's 2560x1600 screen, the window placed by display.ts's chromiumWindowArgs in the
//   screen's bottom-right corner and resized so its viewport is `size`, the picture cropped to that viewport
//   (region.ts) with Chromium's toolbar left out.
// - `window` (castd's): Xvfb exactly `size`, Chromium in kiosk mode filling it, the picture the whole screen.
//
// One display and one Chromium at a time: this machine is shared.

export type StageKind = "daemon" | "window";

// A picture's size in pixels.
export interface Size {
    readonly width: number;
    readonly height: number;
}

export interface StageOptions {
    readonly kind: StageKind;
    readonly size: Size;
    readonly chromium: string;
    // Start Xvfb with its framebuffer in a file, for the display probe (framebuffer.ts).
    readonly framebuffer: boolean;
}

export interface Stage {
    readonly display: { readonly name: string; readonly width: number; readonly height: number };
    readonly xvfbPid: number;
    readonly chromiumPid: number | undefined;
    readonly context: BrowserContext;
    readonly page: Page;
    readonly cdp: CDPSession;
    readonly region: Region;
    // The XWD file Xvfb keeps its screen in, when started with one.
    readonly framebuffer: string | undefined;
    readonly show: (url: string) => Promise<void>;
    readonly close: () => Promise<void>;
}

// Above the daemon's own range (:99-:160) and the agent desktop's, so a run never takes a display a sandbox uses.
const FIRST_DISPLAY = 200;
const LAST_DISPLAY = 260;

const freeDisplay = (): number => {
    for (let number = FIRST_DISPLAY; number <= LAST_DISPLAY; number++) {
        if (!existsSync(`/tmp/.X11-unix/X${number}`) && !existsSync(`/tmp/.X${number}-lock`)) {
            return number;
        }
    }
    throw new Error(`no free X display between :${FIRST_DISPLAY} and :${LAST_DISPLAY}`);
};


const waitFor = async (what: string, ready: () => boolean, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
        if (Date.now() > deadline) {
            throw new Error(`${what} did not come up within ${timeoutMs} ms`);
        }
        await sleep(50);
    }
};

// Chromium's flags as the owner's window is launched with (owner-browser.ts's ownerBrowserArgs), less the profile's
// own settings, which change nothing the stream sees.
const BASE_ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled", "--disable-infobars", "--no-first-run", "--no-default-browser-check"];

export const startStage = async (daemon: Daemon, options: StageOptions): Promise<Stage> => {
    const number = freeDisplay();
    const screen =
        options.kind === "daemon" ? { width: daemon.display.DISPLAY_WIDTH, height: daemon.display.DISPLAY_HEIGHT } : { width: options.size.width, height: options.size.height };
    const display = { name: `:${number}`, ...screen };
    const scratch = mkdtempSync(join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "castbench-"));
    const profile = join(scratch, "profile");
    const fbdir = options.framebuffer ? join(scratch, "fb") : undefined;
    if (fbdir !== undefined) {
        mkdirSync(fbdir);
    }
    // The daemon's own Xvfb line (display.ts), plus -fbdir for the probe: the framebuffer is then a mapped file rather
    // than anonymous memory, which changes where the pixels live and nothing about drawing them.
    const xvfb: ChildProcess = spawn(
        "Xvfb",
        [display.name, "-screen", "0", `${screen.width}x${screen.height}x24`, "-nolisten", "tcp", "-ac", ...(fbdir === undefined ? [] : ["-fbdir", fbdir])],
        { stdio: "ignore" },
    );
    // SIGTERM lets Xvfb remove its socket and lock file; one that ignores it is killed, and the two files it leaves are
    // removed here, or every later run would find the display taken.
    const stopXvfb = async (): Promise<void> => {
        xvfb.kill("SIGTERM");
        await waitFor("Xvfb's exit", () => xvfb.exitCode !== null || xvfb.signalCode !== null, 3000).catch(() => xvfb.kill("SIGKILL"));
        rmSync(`/tmp/.X11-unix/X${number}`, { force: true });
        rmSync(`/tmp/.X${number}-lock`, { force: true });
        rmSync(scratch, { recursive: true, force: true });
    };
    try {
        await waitFor(`Xvfb on ${display.name}`, () => existsSync(`/tmp/.X11-unix/X${number}`), 10_000);
        const windowArgs =
            options.kind === "daemon"
                ? daemon.display.chromiumWindowArgs(display)
                : ["--kiosk", "--window-position=0,0", `--window-size=${screen.width},${screen.height}`];
        const context = await chromium.launchPersistentContext(profile, {
            headless: false,
            executablePath: options.chromium,
            viewport: null,
            // Playwright's automation infobar would sit between the toolbar and the page, a strip no sandbox window has.
            ignoreDefaultArgs: ["--enable-automation"],
            env: { ...process.env, DISPLAY: display.name },
            args: [...BASE_ARGS, ...windowArgs],
        });
        const page = context.pages()[0] ?? (await context.newPage());
        const cdp = await context.newCDPSession(page);
        await page.goto("about:blank");
        let geometry = await daemon.region.readGeometry(page);
        if (geometry === undefined) {
            throw new Error("the stage's window reported no geometry");
        }
        if (options.kind === "daemon") {
            // The viewer's box asks for its viewport size, and the window grows its chrome around it (live-view.ts's
            // sizing): the same here, so the picture is `size` exactly.
            await daemon.region.resizeWindow(cdp, daemon.region.windowBoundsFor(options.size, geometry, screen));
            await sleep(500);
            geometry = (await daemon.region.readGeometry(page)) ?? geometry;
        }
        // castd's picture is its whole screen, whatever border the kiosk window reports.
        const region = options.kind === "daemon" ? daemon.region.regionOf(geometry, screen) : { x: 0, y: 0, width: screen.width, height: screen.height, scale: 1 };
        const chromiumPid = processesWithArg("chrome", profile).find((pid) => readStat(pid)?.ppid === process.pid);
        return {
            display,
            xvfbPid: xvfb.pid ?? 0,
            chromiumPid,
            context,
            page,
            cdp,
            region,
            framebuffer: fbdir === undefined ? undefined : join(fbdir, "Xvfb_screen0"),
            show: async (url) => {
                await page.goto(url);
                await page.waitForFunction(() => document.documentElement.dataset["ready"] === "1");
                await page.bringToFront();
                // Fonts, layout and the first frames of an animation settle before anyone connects.
                await sleep(1000);
            },
            close: async () => {
                // allow(silent-catch): a browser that already exited is closed; Xvfb is stopped next either way.
                await context.close().catch(() => undefined);
                await stopXvfb();
            },
        };
    } catch (error) {
        await stopXvfb();
        throw error;
    }
};
