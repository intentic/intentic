import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { notice, type Notice, type NoticeEvents } from "@intentic/desktop-automation";
import type { Log } from "@intentic/local-agent";
import { baseDir } from "../config.js";
import { audit } from "./audit.js";
import { ScopeError } from "./policy.js";

// What the person at this computer sees while an agent drives its mouse and keyboard, and the one thing they can do
// about it from there: a notice at the top of the screen while any link acted in the last IDLE_MS, holding a hotkey
// that pauses every link's input until it is pressed again. Windows only; elsewhere nothing is shown or toggled.
// (2026-11-20) The same notice stays up while people are connected through intentic-remoted (remote/remote.ts), and the
// same hotkey pauses their input too: remoted reads the pause from its config, which follows the `paused` file.

// The hotkey as the person reads it, which is also how desktop-automation parses it. Three modifiers: no app's own.
export const PAUSE_HOTKEY = "Ctrl+Alt+Shift+P";

// How long the notice outlives the last action: a screenshot and a think between two clicks fit well inside it.
export const IDLE_MS = 30_000;

// Exists while paused, and outlives the agent on purpose: a restart, which a sandbox can ask for, must not lift it.
const pausePath = join(baseDir, "paused");

// When the person paused, or undefined when nothing is paused. Only an absent file is unpaused: a stat that fails
// otherwise throws, and `control` refuses the action rather than reading the person's pause as lifted.
export const readPausedAt = async (): Promise<Date | undefined> => (await stat(pausePath).catch(undefinedIfMissing))?.mtime;

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

// One person connected to this computer through intentic-remoted, as the notice names them: what they do, and over
// which sandbox's uplink.
export type PersonKind = "view" | "control" | "terminal";
export interface PersonOnScreen {
    readonly kind: PersonKind;
    readonly sandboxUrl: string;
}

export interface Indicator {
    // Before every input action: shows the notice under the caller's name, and throws a ScopeError while paused.
    readonly control: (caller: Caller | undefined) => Promise<void>;
    // The link's socket closed, so it is driving nothing.
    readonly release: (sandboxUrl: string) => void;
    // Everyone connected through remoted now: the notice stays up while anyone is, and `log` hears about the hotkey.
    readonly people: (people: readonly PersonOnScreen[], log: Log) => Promise<void>;
}

const PAUSED = `Refused: paused by the person at this computer: they pressed ${PAUSE_HOTKEY}, which stops agents from using its mouse and keyboard until they press it again. Tell the user; do not look for another way to do this on the screen.`;

// A link as a person can recognise it on the notice.
const hostOf = (sandboxUrl: string): string => URL.parse(sandboxUrl)?.host ?? sandboxUrl;

// Which kind of connection the notice names when people are connected in several ways: the screen this person sits at
// comes first, so someone driving it outranks someone watching it, who outranks someone in a terminal, which shows them
// nothing of it.
const PERSON_RANK = { control: 3, view: 2, terminal: 1 } as const satisfies Record<PersonKind, number>;
const PERSON_DOING = {
    control: "using the mouse and keyboard",
    view: "viewing this computer",
    terminal: "in a terminal on this computer",
} as const satisfies Record<PersonKind, string>;

// The person the notice names: the first of the highest-ranked kind. Pure.
const foremostPerson = (people: readonly PersonOnScreen[]): PersonOnScreen | undefined =>
    people.toSorted((a, b) => PERSON_RANK[b.kind] - PERSON_RANK[a.kind])[0];

// What the notice says of the people connected, by the foremost kind among them; undefined for nobody. Pure.
export const peopleSentence = (people: readonly PersonOnScreen[]): string | undefined => {
    const foremost = foremostPerson(people);
    if (foremost === undefined) {
        return undefined;
    }
    const several = people.filter((person) => person.kind === foremost.kind).length > 1;
    return `${several ? "People are" : "A person is"} ${PERSON_DOING[foremost.kind]}`;
};

// What the notice shows: an agent driving first, under its sandbox (`agentUrl`, the link that acted last); people
// connected after it, under theirs when no agent drives; and the hotkey, unless another program holds it. Pure.
export interface NoticeState {
    readonly driving: boolean;
    readonly agentUrl: string | undefined;
    readonly people: readonly PersonOnScreen[];
    readonly paused: boolean;
    readonly hotkey: boolean;
}
const noticeText = ({ driving, agentUrl, people, paused, hotkey }: NoticeState): string => {
    const person = foremostPerson(people);
    const parts = [
        ...(driving ? [paused ? "Intentic agent paused" : "Intentic agent is controlling this computer"] : []),
        ...(person === undefined ? [] : [`${peopleSentence(people) ?? ""}${paused ? " (input paused)" : ""}`]),
    ];
    const host = driving ? agentUrl : person?.sandboxUrl;
    const who = host === undefined ? "" : ` · ${hostOf(host)}`;
    const keys = hotkey ? ` · ${PAUSE_HOTKEY} ${paused ? "resumes" : "pauses"}` : "";
    return `${parts.join(" · ")}${who}${keys}`;
};

// The helper window itself: opened when there is something to show, closed when there is nothing, and not opened again
// while the session that saw it die lasts, so a broken helper cannot respawn per click. `words` is what it shows, given
// whether the hotkey is still this agent's.
const noticeWindow = (deps: IndicatorDeps, toggle: () => void, log: (message: string) => void, words: (hotkey: boolean) => string) => {
    let shown: Notice | undefined;
    let broken = false;
    let hotkey = true;
    const show = (): void => shown?.show(words(hotkey));
    const open = (): void => {
        try {
            shown = deps.open({
                hotkey: toggle,
                hotkeyTaken: () => {
                    hotkey = false;
                    log(`${PAUSE_HOTKEY} is held by another program, so it cannot pause agents here until that program lets go of it.`);
                    show();
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
    return {
        show,
        // Shown with the words of now, opened first unless this session's helper broke.
        up: (): void => {
            if (shown === undefined && !broken) {
                open();
            }
            show();
        },
        // Closed, and the next session starts afresh.
        down: (): void => {
            const closing = shown;
            shown = undefined;
            broken = false;
            hotkey = true;
            closing?.close();
        },
    };
};

export const createIndicator = (deps: IndicatorDeps): Indicator => {
    // Every link that acted within IDLE_MS, the latest last; the notice is open exactly while this, or `connected`, is not empty.
    const driving = new Map<string, { readonly caller: Caller | undefined; readonly timer: ReturnType<typeof setTimeout> }>();
    // The people remoted last said are connected, and the log that hears about them.
    let connected: readonly PersonOnScreen[] = [];
    let peopleLog: Log | undefined;
    // Undefined until read from disk by the first action; only the hotkey changes it after that.
    let paused: boolean | undefined;
    // Saves in the order the person pressed, so two quick presses cannot land on disk the other way round.
    let saved = Promise.resolve();

    const latest = (): Caller | undefined => [...driving.values()].at(-1)?.caller;
    const log = (message: string): void => (latest()?.log ?? peopleLog)?.(message);

    const toggle = (): void => {
        const now = paused !== true;
        paused = now;
        saved = saved.then(async () => await deps.setPaused(now)).catch((error: unknown) => log(`could not save the pause: ${errorMessage(error)}`));
        const detail = `${now ? "paused" : "resumed"} by the person at this computer (${PAUSE_HOTKEY})`;
        log(detail);
        void deps.audit({ tool: "local-pause", ok: true, detail });
        helper.show();
    };
    const helper = noticeWindow(deps, toggle, log, (hotkey) =>
        noticeText({ driving: driving.size > 0, agentUrl: latest()?.sandboxUrl, people: connected, paused: paused === true, hotkey }),
    );
    // The notice as it should be now: up while anyone drives or is connected, else down.
    const settle = (): void => (driving.size > 0 || connected.length > 0 ? helper.up() : helper.down());

    const release = (sandboxUrl: string): void => {
        const entry = driving.get(sandboxUrl);
        if (entry === undefined) {
            return;
        }
        clearTimeout(entry.timer);
        driving.delete(sandboxUrl);
        settle();
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
            settle();
            if (paused) {
                throw new ScopeError(PAUSED);
            }
        },
        release,
        people: async (people, said) => {
            connected = people;
            peopleLog = said;
            if (people.length > 0 && paused === undefined) {
                // allow(silent-catch): a pause that cannot be read is remoted's to apply from its config; the notice only words it
                const onDisk = await deps.paused().catch(() => undefined);
                paused ??= onDisk;
            }
            settle();
        },
    };
};

let machine: Indicator | undefined;

// Who hears that the person pressed the hotkey, once the pause is on disk: remoted's config follows it (remote/remote.ts).
const pauseListeners = new Set<(paused: boolean) => void>();
export const onPauseChanged = (listener: (paused: boolean) => void): (() => void) => {
    pauseListeners.add(listener);
    return () => void pauseListeners.delete(listener);
};

// This process's one indicator: one screen, whichever links are driving it.
export const machineIndicator = (): Indicator =>
    (machine ??= createIndicator({
        open: (events) => notice(PAUSE_HOTKEY, events),
        paused: async () => (await readPausedAt()) !== undefined,
        setPaused: async (paused) => {
            if (paused) {
                await mkdir(baseDir, { recursive: true, mode: 0o700 });
                await writeFile(pausePath, "", { mode: 0o600 });
            } else {
                await rm(pausePath, { force: true });
            }
            for (const listener of pauseListeners) {
                listener(paused);
            }
        },
        audit,
    }));
