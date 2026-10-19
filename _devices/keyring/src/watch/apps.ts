import { ANSWER_MARK } from "../powershell.js";
import type { Runner } from "../run.js";
import { type AskKeyring, type ChipPlace, ChipController, type ChipSurface, WatchEventSchema, type WatchEvent } from "./chip.js";
import { type LineChild, type SpawnLines, spawnLines } from "./lines-child.js";
import { LINUX_CHIP_ACTION, LINUX_WATCH_COMMAND, linuxChipArgs, linuxWatchArgs } from "./watch-linux.js";
import { HIDE_COMMAND, showCommand, WINDOWS_WATCH_COMMAND, windowsWatchArgs } from "./watch-windows.js";

// The chip's watcher as the session helper runs it (helper.ts): started while the vault says remembering from programs
// is on, stopped when it is turned off. One watcher program per platform reports focus changes (watch-windows.ts,
// watch-linux.ts); the ChipController decides what to show (chip.ts). A watcher that stops by itself is started again
// at the next `start`, unless it said it cannot run here at all (no AT-SPI bindings), when it stays off.

export interface AppsWatch {
    readonly start: () => void;
    readonly stop: () => void;
}

// The exit status the Linux watcher gives when python3 has no AT-SPI bindings: nothing to retry.
const CANNOT_WATCH_HERE = 3;

/** A watcher line read as an event: the marked JSON line, or undefined for anything else it printed. Pure. */
export const watchEventOf = (line: string): WatchEvent | undefined => {
    const at = line.indexOf(ANSWER_MARK);
    if (at === -1) {
        return undefined;
    }
    try {
        const parsed = WatchEventSchema.safeParse(JSON.parse(line.slice(at + ANSWER_MARK.length)));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a line that is not JSON is not an event, and the watcher prints nothing else worth reading
        return undefined;
    }
};

interface Platform {
    readonly command: string;
    readonly args: readonly string[];
    readonly surface: (watcher: LineChild, spawn: SpawnLines, onClick: () => void) => ChipSurface;
}

// Windows: the watcher program draws the chip itself, told what to show on its standard input.
const windowsSurface = (watcher: LineChild): ChipSurface => ({
    show: (label: string, at: ChipPlace) => watcher.write(showCommand(label, at)),
    hide: () => watcher.write(HIDE_COMMAND),
});

// Linux: one notification per chip, taken down when the chip hides.
const linuxSurface = (_watcher: LineChild, spawn: SpawnLines, onClick: () => void): ChipSurface => {
    let shown: LineChild | undefined;
    return {
        show: (label, at) => {
            shown?.stop();
            const notice = spawn("notify-send", linuxChipArgs(label, at));
            notice.onLine((line) => {
                if (line.trim() === LINUX_CHIP_ACTION) {
                    onClick();
                }
            });
            shown = notice;
        },
        hide: () => {
            shown?.stop();
            shown = undefined;
        },
    };
};

const platformOf = (platform: NodeJS.Platform): Platform | undefined => {
    switch (platform) {
        case "win32":
            return { command: WINDOWS_WATCH_COMMAND, args: windowsWatchArgs(), surface: windowsSurface };
        case "linux":
            return { command: LINUX_WATCH_COMMAND, args: linuxWatchArgs(), surface: linuxSurface };
        default:
            return undefined;
    }
};

export const appsWatchFor = (
    _runner: Runner,
    ask: AskKeyring,
    log: (message: string) => void,
    platform: NodeJS.Platform = process.platform,
    spawn: SpawnLines = spawnLines,
): AppsWatch | undefined => {
    const chosen = platformOf(platform);
    if (chosen === undefined) {
        return undefined;
    }
    let running: LineChild | undefined;
    let never = false;
    return {
        start: () => {
            if (running !== undefined || never) {
                return;
            }
            const watcher = spawn(chosen.command, chosen.args);
            running = watcher;
            // The click comes back through the surface on Linux (the notification's action), so it names the controller late.
            const controller: ChipController = new ChipController({ ask, surface: chosen.surface(watcher, spawn, () => void controller.onClick()), log });
            watcher.onLine((line) => {
                const event = watchEventOf(line);
                if (event !== undefined) {
                    void controller.onEvent(event);
                }
            });
            watcher.onExit((code) => {
                if (running === watcher) {
                    running = undefined;
                }
                if (code === CANNOT_WATCH_HERE) {
                    never = true;
                    log("the chip stays off: python3 has no AT-SPI bindings (python3-gi with the Atspi typelib)");
                } else if (code !== null && code !== 0) {
                    log(`the focus watcher stopped (exit ${String(code)}); it starts again within a minute`);
                }
            });
            log("watching for password fields, to offer the chip");
        },
        stop: () => {
            const watcher = running;
            running = undefined;
            watcher?.stop();
        },
    };
};
