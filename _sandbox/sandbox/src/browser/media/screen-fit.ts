import { existsSync, writeFileSync } from "node:fs";
import { readTextIfExistsSync } from "@intentic/base/fs";
import { join } from "node:path";
import type { CastGeometry } from "./castd-control.js";
import { signalGroup } from "../../workload/process-group.js";
import { spawnAs } from "../../workload/workload-class.js";
import { probe } from "./display-command.js";

/* Screen = viewport, the daemon's half (castd's is the RandR resize). A window the daemon launches starts fullscreen
   (chromiumWindowArgs): no tab strip, no toolbar, so the X screen is the page's viewport and castd resizes the screen to
   the driving viewer's box × pixel ratio. Measured on Chromium 1248 against a bare Xvfb (2026-11-19, no window manager):

   - Chromium does not follow a RandR resize by itself in any mode (--kiosk, --start-fullscreen, CDP fullscreen), and
     CDP's Browser.setWindowBounds takes a fullscreen window out of fullscreen, toolbar back. A ConfigureWindow of its
     toplevel from outside does follow, and keeps it fullscreen. castd does that for every window that covered the old
     screen after each resize (`fitsWindows`); the daemon fits the window once when castd starts, since a fresh window
     covers no screen (it opens at about half the screen at 10,10) and RandR puts a dead castd's screen back.
   - --kiosk drops the page's context menu; --start-fullscreen keeps it (with an "Exit full screen" item, and Chromium's
     "press and hold Esc" bubble for the first seconds). A window someone took out of fullscreen is put back while it
     is watched (media-view.ts).
   - The device pixel ratio follows XSETTINGS `Xft/DPI` live (96 × ratio × 1024): 1 → 2 → 1.5 without a relaunch,
     pixel-exact. So the daemon keeps an xsettingsd per display at castd's scale, unless castd publishes it itself.

   Rejected: `--force-device-scale-factor`, which needs a relaunch (and loses whatever the window held) per change. */

const XSETTINGSD = "/usr/bin/xsettingsd";
const XDOTOOL = "/usr/bin/xdotool";
const XPROP = "/usr/bin/xprop";

// Xft/DPI as XSETTINGS carries it: dots per inch × 1024, 96 being a ratio of 1.
const xftDpiOf = (scale: number): number => Math.round(96 * scale) * 1024;

const xsettingsConfOf = (scale: number): string => `Xft/DPI ${xftDpiOf(scale)}\n`;

// The windows a fit resizes: Chromium's tabbed windows (WM_WINDOW_ROLE "browser"), never a popup ("pop-up"), a menu or a
// bubble, which keep the size their page or Chromium gave them.
const browserWindows = async (display: string): Promise<string[]> => {
    const env = { ...process.env, DISPLAY: display };
    const found = await probe([XDOTOOL, "search", "--onlyvisible", "--class", "chrom"], env);
    const ids = (found ?? "").split("\n").filter((id) => id.trim() !== "");
    const roles = await Promise.all(
        ids.map(async (id) => ((await probe([XPROP, "-id", id, "WM_WINDOW_ROLE"], env))?.includes('"browser"') === true ? id : undefined)),
    );
    return roles.filter((id): id is string => id !== undefined);
};

// Makes every browser window on the display cover its screen, as a window manager does for a fullscreen one.
export const fitWindows = async (display: string, size: { readonly width: number; readonly height: number }): Promise<number> => {
    if (!existsSync(XDOTOOL) || !existsSync(XPROP)) {
        return 0;
    }
    const env = { ...process.env, DISPLAY: display };
    const windows = await browserWindows(display);
    for (const id of windows) {
        // A window closed between the search and the move has nothing to fit, which the probe reads as no output.
        await probe([XDOTOOL, "windowmove", id, "0", "0", "windowsize", id, String(size.width), String(size.height)], env);
    }
    return windows.length;
};

// One xsettingsd per display, its config and pid beside castd's socket; detached like the display, so a daemon
// restart finds it serving and keeps it.
export interface ScaleSetting {
    readonly set: (scale: number) => void;
    readonly stop: () => void;
}

// A process that is gone has no /proc entry, which reads as no argv.
const alive = (pid: number, conf: string): boolean => (readTextIfExistsSync(`/proc/${pid}/cmdline`) ?? "").split("\0").includes(conf);

export const startScaleSetting = (display: string, name: string, dir: string, scale: number): ScaleSetting | undefined => {
    if (!existsSync(XSETTINGSD)) {
        return undefined;
    }
    const conf = join(dir, `${name}.xsettings`);
    const pidFile = join(dir, `${name}.xsettings.pid`);
    let current = scale;
    writeFileSync(conf, xsettingsConfOf(scale), { mode: 0o600 });
    let pid = Number(readTextIfExistsSync(pidFile)?.trim() ?? Number.NaN);
    if (Number.isInteger(pid) && pid > 0 && alive(pid, conf)) {
        // An earlier daemon's: told to read the config again, which now says this scale.
        signalGroup(pid, "SIGHUP");
    } else {
        const child = spawnAs({ class: "service" }, XSETTINGSD, ["-c", conf], { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: display } });
        child.on("error", () => undefined);
        child.unref();
        pid = child.pid ?? Number.NaN;
        writeFileSync(pidFile, String(pid), { mode: 0o600 });
    }
    // xsettingsd leads a group of its own (spawned detached); one gone with its display is the outcome asked for.
    const signal = (sent: NodeJS.Signals): void => {
        signalGroup(pid, sent);
    };
    return {
        set: (next) => {
            if (next === current || !Number.isFinite(next) || next <= 0) {
                return;
            }
            current = next;
            writeFileSync(conf, xsettingsConfOf(next), { mode: 0o600 });
            signal("SIGHUP");
        },
        stop: () => signal("SIGTERM"),
    };
};

// What changed between two looks at castd's geometry that the daemon must act on: the screen's size (to fit windows
// castd does not fit itself) and the scale (for XSETTINGS when castd does not publish it).
export interface ScreenChanges {
    // The windows need fitting to a new screen.
    readonly fit: boolean;
    // XSETTINGS needs the new scale.
    readonly scale: boolean;
}

export const screenChanges = (before: CastGeometry | undefined, after: CastGeometry): ScreenChanges => ({
    fit: after.fitsWindows !== true && (before === undefined || before.screen.width !== after.screen.width || before.screen.height !== after.screen.height),
    scale: after.xsettings !== true && (before === undefined || before.scale !== after.scale),
});
