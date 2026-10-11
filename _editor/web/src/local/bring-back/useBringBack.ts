import { computed, shallowReactive } from "vue";
import { askLocalApp, LOCAL_PROJECT_EVENT, type LocalVerb, type SyncDirection } from "../../app/environments/local";
import { activeSandboxId } from "../../lib/activeSandbox";
import { answered, BRING_BACK_CAP, type BringBackState, chosenPaths, IDLE, type ProjectAnswer, projectAnswer, type SandboxChange } from "./bringBack";

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

// Which folder each verb was last asked for: an answer names its verb, not its folder, and belongs to the folder that
// asked even when the window has moved to another one since.
const askedBy = new Map<string, string>();

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
    const folder = askedBy.get(verb) ?? folderOn();
    askedBy.delete(verb);
    states.set(folder, answered(states.get(folder) ?? IDLE, answer));
};

let listening = false;
const listen = (): void => {
    if (!listening) {
        listening = true;
        window.addEventListener(LOCAL_PROJECT_EVENT, onAnswer);
    }
};

/** Test seam: the exchange is module state, and one left in it would follow one test into the next. */
export const forgetBringBack = (): void => {
    states.clear();
    askedBy.clear();
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
        askedBy.set(verb, folder);
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

    return { state, check, bringBack, undo, switchTo };
};
