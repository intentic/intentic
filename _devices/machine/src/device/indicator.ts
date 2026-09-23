import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { notice, type Notice, type NoticeEvents } from "@intentic/desktop-automation";
import type { Log } from "@intentic/local-agent";
import { baseDir } from "../config.js";
import { audit } from "./audit.js";
import { ScopeError } from "./policy.js";

// What the person at this computer sees while an agent drives its mouse and keyboard, and the one thing they can do
// about it from there: a notice at the top of the screen while any link acted in the last IDLE_MS, holding a hotkey
// that pauses every link's input until it is pressed again. Windows only; elsewhere nothing is shown or toggled.

// The hotkey as the person reads it, which is also how desktop-automation parses it. Three modifiers: no app's own.
export const PAUSE_HOTKEY = "Ctrl+Alt+Shift+P";

// How long the notice outlives the last action: a screenshot and a think between two clicks fit well inside it.
export const IDLE_MS = 30_000;

// Exists while paused, and outlives the agent on purpose: a restart, which a sandbox can ask for, must not lift it.
const pausePath = join(baseDir, "paused");

// When the person paused, or undefined when nothing is paused.
export const readPausedAt = async (): Promise<Date | undefined> => (await stat(pausePath).catch(() => undefined))?.mtime;

// The link a tool call arrived on, set around each MCP message by the router: the sandbox the notice names, the link
// whose disconnect takes it down, and the log that hears about it.
export interface Caller {
    readonly sandboxUrl: string;
    readonly log: Log;
}
export const calling = new AsyncLocalStorage<Caller>();

// Everything the state machine touches but the clock. The process's own are in machineIndicator; a test's are fakes.
export interface IndicatorDeps {
    // Opens the notice, or answers undefined where there is none to open.
    readonly open: (events: NoticeEvents) => Notice | undefined;
    readonly paused: () => Promise<boolean>;
    readonly setPaused: (paused: boolean) => Promise<void>;
    readonly audit: (entry: { tool: string; ok: boolean; detail: string }) => Promise<void>;
}

export interface Indicator {
    // Before every input action: shows the notice under the caller's name, and throws a ScopeError while paused.
    readonly control: (caller: Caller | undefined) => Promise<void>;
    // The link's socket closed, so it is driving nothing.
    readonly release: (sandboxUrl: string) => void;
}

const PAUSED = `Refused: paused by the person at this computer: they pressed ${PAUSE_HOTKEY}, which stops agents from using its mouse and keyboard until they press it again. Tell the user; do not look for another way to do this on the screen.`;

// A link as a person can recognise it on the notice.
const hostOf = (sandboxUrl: string): string => URL.parse(sandboxUrl)?.host ?? sandboxUrl;

export const createIndicator = (deps: IndicatorDeps): Indicator => {
    // Every link that acted within IDLE_MS, the latest last; the notice is open exactly while this is not empty.
    const driving = new Map<string, { readonly caller: Caller | undefined; readonly timer: ReturnType<typeof setTimeout> }>();
    let shown: Notice | undefined;
    // Undefined until read from disk by the first action; only the hotkey changes it after that.
    let paused: boolean | undefined;
    // A helper that died by itself is not replaced until the links go quiet, so a broken one cannot respawn per click.
    let broken = false;
    let hotkey = true;
    // Saves in the order the person pressed, so two quick presses cannot land on disk the other way round.
    let saved = Promise.resolve();

    const latest = (): Caller | undefined => [...driving.values()].at(-1)?.caller;
    const log = (message: string): void => latest()?.log(message);

    const text = (): string => {
        const caller = latest();
        const who = caller === undefined ? "" : ` · ${hostOf(caller.sandboxUrl)}`;
        const keys = hotkey ? ` · ${PAUSE_HOTKEY} ${paused === true ? "resumes" : "pauses"}` : "";
        return `${paused === true ? "Intentic agent paused" : "Intentic agent is controlling this computer"}${who}${keys}`;
    };

    const toggle = (): void => {
        const now = paused !== true;
        paused = now;
        saved = saved.then(async () => await deps.setPaused(now)).catch((error: unknown) => log(`could not save the pause: ${errorMessage(error)}`));
        const detail = `${now ? "paused" : "resumed"} by the person at this computer (${PAUSE_HOTKEY})`;
        log(detail);
        void deps.audit({ tool: "local-pause", ok: true, detail });
        shown?.show(text());
    };

    const open = (): void => {
        try {
            shown = deps.open({
                hotkey: toggle,
                hotkeyTaken: () => {
                    hotkey = false;
                    log(`${PAUSE_HOTKEY} is held by another program, so it cannot pause agents here until that program lets go of it.`);
                    shown?.show(text());
                },
                exited: (said) => {
                    shown = undefined;
                    broken = true;
                    log(`the on-screen notice stopped: ${said}`);
                },
            });
        } catch (error) {
            broken = true;
            log(`the on-screen notice could not open: ${errorMessage(error)}`);
        }
    };

    const release = (sandboxUrl: string): void => {
        const entry = driving.get(sandboxUrl);
        if (entry === undefined) {
            return;
        }
        clearTimeout(entry.timer);
        driving.delete(sandboxUrl);
        if (driving.size > 0) {
            shown?.show(text());
            return;
        }
        const closing = shown;
        shown = undefined;
        broken = false;
        hotkey = true;
        closing?.close();
    };

    return {
        control: async (caller) => {
            if (paused === undefined) {
                const onDisk = await deps.paused();
                paused ??= onDisk;
            }
            const key = caller?.sandboxUrl ?? "";
            clearTimeout(driving.get(key)?.timer);
            // Deleted first so it is re-inserted last: the notice names whoever acted most recently.
            driving.delete(key);
            const timer = setTimeout(() => release(key), IDLE_MS);
            timer.unref();
            driving.set(key, { caller, timer });
            if (shown === undefined && !broken) {
                open();
            }
            shown?.show(text());
            if (paused) {
                throw new ScopeError(PAUSED);
            }
        },
        release,
    };
};

let machine: Indicator | undefined;

// This process's one indicator: one screen, whichever links are driving it.
export const machineIndicator = (): Indicator =>
    (machine ??= createIndicator({
        open: (events) => notice(PAUSE_HOTKEY, events),
        paused: async () => (await readPausedAt()) !== undefined,
        setPaused: async (paused) => {
            if (!paused) {
                await rm(pausePath, { force: true });
                return;
            }
            await mkdir(baseDir, { recursive: true, mode: 0o700 });
            await writeFile(pausePath, "", { mode: 0o600 });
        },
        audit,
    }));
