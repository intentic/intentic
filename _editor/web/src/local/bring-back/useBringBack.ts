import { computed, onScopeDispose, shallowReactive, watch } from "vue";
import { askLocalApp, LOCAL_PROJECT_EVENT, type LocalVerb, type SyncDirection } from "../../app/environments/local";
import { activeSandboxId } from "../../lib/activeSandbox";
import {
    answered,
    BRING_BACK_CAP,
    type BringBackState,
    chosenPaths,
    IDLE,
    type ProjectAnswer,
    projectAnswer,
    type SandboxChange,
    sectionShown,
} from "./bringBack";

// The Bring back section's state and its four asks (bringBack.ts). Each ask moves the section to its waiting step and
// sends one link; the app's `intentic:project` answer, whenever it lands, settles it.
//
// THE EXCHANGE IS THE WINDOW'S, NOT THE SECTION'S. The section is drawn only while the file tree shows and no file is
// open, and an answer takes seconds, so the reader is often elsewhere when it lands; a bring-back's answer carries the
// restore point its Undo needs, and the app sends it once. So the state is held here per folder (by the folder's own
// sandbox, the one the window is on), and the answer is heard here for as long as the window lives, whether or not the
// section is on screen. It stays until the next ask on that folder replaces it.

// allow(module-state): each folder's bring-back exchange with the desktop app, held by folder for as long as the window lives
const states = shallowReactive(new Map<string, BringBackState>());

// Which folders each verb was asked for, oldest first: an answer names its verb, not its folder, and belongs to the folder
// that asked even when the window has moved to another one since. A queue, since a window that checks each folder it
// arrives at can have two checks out at once.
const askedBy = new Map<string, string[]>();
const settleAsked = (verb: string, waiting: readonly string[]): void => {
    if (waiting.length === 0) {
        askedBy.delete(verb);
    } else {
        askedBy.set(verb, [...waiting]);
    }
};
const noteAsked = (verb: string, folder: string): void => settleAsked(verb, [...(askedBy.get(verb) ?? []), folder]);
const takeAsked = (verb: string): string | undefined => {
    const [first, ...rest] = askedBy.get(verb) ?? [];
    settleAsked(verb, rest);
    return first;
};
// An ask given up on leaves the queue, so the answers after it are not read as its.
const dropAsked = (verb: string, folder: string): void => {
    const waiting = askedBy.get(verb) ?? [];
    const at = waiting.indexOf(folder);
    if (at !== -1) {
        settleAsked(verb, waiting.toSpliced(at, 1));
    }
};

const folderOn = (): string => activeSandboxId.value ?? ``;

const verbOf = (answer: ProjectAnswer): string => {
    switch (answer.kind) {
        case `changes`:
            return `changes`;
        case `brought-back`:
            return `bring-back`;
        case `restored`:
            return `restore`;
        case `direction`:
            return `direction`;
        default:
            return answer.verb;
    }
};

const onAnswer = (event: Event): void => {
    const answer = projectAnswer(event);
    if (answer === undefined) {
        return;
    }
    const verb = verbOf(answer);
    const folder = takeAsked(verb) ?? folderOn();
    states.set(folder, answered(states.get(folder) ?? IDLE, answer));
};

let listening = false;
const listen = (): void => {
    if (!listening) {
        listening = true;
        window.addEventListener(LOCAL_PROJECT_EVENT, onAnswer);
    }
};

// When each folder was last checked on the window's own initiative, so a reader flicking between windows asks the app
// once a minute at most: every check starts the machine agent, flushes the sync and lists the sandbox's copy. Kept per
// folder for as long as the window lives, as the exchange itself is; a plain Map, since nothing draws from it.
const quietAt = new Map<string, number>();
const QUIET_EVERY_MS = 60_000;
// A quiet check the app never answered (a folder it no longer keeps) gives way to the next one after this; the machine
// agent's own run is cut at 90 seconds (project.rs `agent_run`), so an answer that is coming has come by then.
const QUIET_GIVE_UP_MS = 120_000;
// How long a folder is on screen before its first check: past a reader flicking through folders, and past the folder's
// own listing, which the check would otherwise compete with for the disk.
const ARRIVAL_SETTLE_MS = 2_000;

/** Test seam: the exchange is module state, and one left in it would follow one test into the next. */
export const forgetBringBack = (): void => {
    states.clear();
    askedBy.clear();
    quietAt.clear();
    window.removeEventListener(LOCAL_PROJECT_EVENT, onAnswer);
    listening = false;
};

export const useBringBack = () => {
    listen();
    const state = computed<BringBackState>(() => states.get(folderOn()) ?? IDLE);

    // Moves the folder on screen to the state `next` gives, and sends the verb that one answer will settle.
    const ask = (next: (now: BringBackState) => BringBackState, verb: LocalVerb, payload?: Parameters<typeof askLocalApp>[1]): void => {
        const folder = folderOn();
        states.set(folder, next(states.get(folder) ?? IDLE));
        noteAsked(verb, folder);
        askLocalApp(verb, payload);
    };

    const check = (): void => ask((now) => ({ ...now, step: { at: `checking` } }), `changes`);
    // The chosen changes, always by name, so what comes back is what the review showed. Nothing chosen, or more than one
    // link carries, is refused here as the review refuses it.
    const bringBack = (changes: readonly SandboxChange[], chosen: ReadonlySet<string>): void => {
        const paths = chosenPaths(changes, chosen);
        if (paths.length === 0 || paths.length > BRING_BACK_CAP) {
            return;
        }
        ask((now) => ({ ...now, step: { at: `bringing`, count: paths.length } }), `bring-back`, { paths });
    };
    // Puts the folder back where the last bring-back found it.
    const undo = (): void => {
        const { step } = state.value;
        if (step.at !== `brought`) {
            return;
        }
        ask((now) => ({ ...now, step: { at: `restoring` } }), `restore`, { point: step.point });
    };
    const switchTo = (direction: SyncDirection): void =>
        ask((now) => ({ ...now, switching: true, switchError: undefined }), `direction`, { value: direction });

    // Drawn only with something to say (bringBack.ts `sectionShown`).
    const shown = computed(() => sectionShown(state.value));

    return { state, shown, check, bringBack, undo, switchTo };
};

// One check the reader did not ask for, unless the folder was checked lately or has an ask of its own on its way.
const checkQuietly = (): void => {
    const folder = folderOn();
    const now = states.get(folder) ?? IDLE;
    const last = quietAt.get(folder);
    const busy = now.quiet || now.step.at === `checking` || now.step.at === `bringing` || now.step.at === `restoring`;
    if (busy || (last !== undefined && Date.now() - last < QUIET_EVERY_MS)) {
        return;
    }
    quietAt.set(folder, Date.now());
    states.set(folder, { ...now, quiet: true });
    noteAsked(`changes`, folder);
    askLocalApp(`changes`);
    setTimeout(() => {
        const later = states.get(folder);
        if (later?.quiet === true) {
            states.set(folder, { ...later, quiet: false });
            dropAsked(`changes`, folder);
        }
    }, QUIET_GIVE_UP_MS);
};

/**
 * WHAT AGENTS CHANGED, FOUND WITHOUT A PRESS: the folder on screen checked when it is ready to be (its sandbox made and
 * its first copy done, `ready`), and again whenever the reader comes back to the window, at most once a minute. So the
 * Bring back section appears when there is something to bring back and is absent otherwise, rather than standing under
 * every folder with a sandbox offering a check (2026-10-12). Held by the folder's page (LocalFiles.vue), so it lasts as
 * long as the folder is on screen.
 */
export const useQuietChecks = (ready: () => boolean): void => {
    listen();
    const maybe = (): void => {
        if (ready() && document.visibilityState === `visible`) {
            checkQuietly();
        }
    };
    let settling: ReturnType<typeof setTimeout> | undefined;
    watch(
        ready,
        (now) => {
            clearTimeout(settling);
            if (now) {
                settling = setTimeout(maybe, ARRIVAL_SETTLE_MS);
            }
        },
        { immediate: true },
    );
    window.addEventListener(`focus`, maybe);
    document.addEventListener(`visibilitychange`, maybe);
    onScopeDispose(() => {
        clearTimeout(settling);
        window.removeEventListener(`focus`, maybe);
        document.removeEventListener(`visibilitychange`, maybe);
    });
};
