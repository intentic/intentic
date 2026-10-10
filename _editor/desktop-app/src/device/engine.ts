import { t } from "@intentic/ui/i18n";
import { confirm } from "@tauri-apps/plugin-dialog";
import { computed, ref } from "vue";
import { setEngine, track } from "../analytics";
import {
    engineCleanup,
    engineMove,
    enginePrefer,
    engineStatus,
    type EngineMoveEnd,
    type EngineMoveEvent,
    type EngineStatus,
    type MoveTarget,
} from "../desktop";
import { endOf, engineOf, foldMove, keptCopiesOf, pcEngineOf, startMove, type MoveProgress } from "./engineMove";
import { running, start } from "./runs";

// WHICH ENGINE THIS PC'S SANDBOXES RUN ON, AND THE MOVE TO THE OTHER (src-tauri/src/engine.rs): Docker Desktop or
// Intentic's engine, as `ic engine status` says when a window starts, when This device opens and after anything here
// changes it; every sandbox moved at the reader's word, each step ic takes heard by every window (engineMove.ts reads
// them); the reader's "Not now"; and the copies a move leaves on the engine it left. The engine card draws it
// (components/EngineCard.vue).

// The run a move reports under, as every run here does (runs.ts): while it lasts, the page's other verbs wait.
const MOVE_RUN = `engine-move`;

/** What ic last said of the engine; undefined before it has, and on a computer that is not a Windows PC. */
export const engineState = ref<EngineStatus | undefined>(undefined);
/** This PC's sandboxes run on Intentic's engine: the engine a start starts, and the one the page names when it is down. */
export const onOurEngine = computed(() => pcEngineOf(engineState.value?.engine) === `intentic`);
/** Intentic's engine was stopped on purpose (`ic engine stop`): nothing in the background starts it, only a person. */
export const ourEngineHeld = computed(() => onOurEngine.value && engineState.value?.held === true);
/** A move under way: this window's own, one another window started, or one only the status shows (Repair's). */
export const engineMoving = ref<MoveProgress | undefined>(undefined);
/** How the last move this window followed ended, until the reader puts it away or another begins. */
export const engineMoveEnd = ref<EngineMoveEnd | undefined>(undefined);
/** A move this window asked for that never ran (no ic beside the app), in the app's words. */
export const engineMoveError = ref<string | undefined>(undefined);
/** The copies moves left are being removed. */
export const engineCleaning = ref(false);
/** What came of removing them, when it was not all of them: the failure, or the engine that kept its copies. */
export const engineCleanupNote = ref<string | undefined>(undefined);
/** The reader's "Not now" did not take. */
export const engineOfferError = ref<string | undefined>(undefined);

/* Only the newest read writes: an answer from before a move ended would put the old engine back on screen. */
let reads = 0;

/** Ask ic again which engine this PC runs on, and whether a move runs that this window has not heard a step of. */
export const loadEngine = async (): Promise<void> => {
    reads += 1;
    const read = reads;
    let status: EngineStatus | null;
    try {
        status = await engineStatus();
    } catch (error) {
        console.error(`[device] the engine's status could not be read:`, error);
        return;
    }
    // No answer (not a Windows PC, or ic missing or silent this once): what was last known stands.
    if (read !== reads || status === null) {
        return;
    }
    engineState.value = status;
    setEngine(status.engine);
    const moving = status.moves?.moving === true;
    const held = engineMoving.value;
    if (moving && held === undefined && own === undefined) {
        engineMoving.value = startMove(pcEngineOf(status.moves?.to), `status`);
    } else if (!moving && held?.source === `status`) {
        // Over, with no end to hear: the status is all there is to say of it.
        engineMoving.value = undefined;
    }
};

/** While a move this window hears nothing of runs (Repair's, a terminal's), the status is how it learns of its end. */
export const followEngine = (): void => {
    if (engineMoving.value?.source === `status`) {
        void loadEngine();
    }
};

// Where this window's own move is between its answer (`engineMove`) and its last step (`exit`), which reach the window
// in either order: whichever comes first ends it on screen, and the other is known for what it is when it comes.
type OwnMove = `running` | `exitHeard` | `answered` | undefined;
let own: OwnMove;
// Read through a call after an await: `hearEngineMove` may have changed it meanwhile, which narrowing cannot see.
const ownNow = (): OwnMove => own;

const finish = (end: EngineMoveEnd | undefined, error: string | undefined): void => {
    engineMoving.value = undefined;
    engineMoveEnd.value = end;
    engineMoveError.value = error;
    void loadEngine();
};

/** One step of a move, from whichever window started it (`desktop://engine-move`). */
export const hearEngineMove = (event: EngineMoveEvent): void => {
    if (own === `answered`) {
        // Steps of this window's own move that came after its answer, which said all they would.
        if (event.step === `exit`) {
            own = undefined;
        }
        return;
    }
    const held = engineMoving.value;
    if (event.step !== `exit`) {
        // A move seen in the status that steps are heard of is one of this app's own.
        const from = held === undefined ? startMove(undefined, `heard`) : held.source === `status` ? { ...held, source: `heard` as const } : held;
        engineMoving.value = foldMove(from, event);
        return;
    }
    const end = endOf(event);
    // ic refused a move of this app's because one ran from elsewhere: that one goes on, as this window's reading of it.
    if (held?.source !== `ours` && end?.outcome === `busy`) {
        return;
    }
    if (held?.source === `ours`) {
        own = `exitHeard`;
    }
    finish(end, undefined);
};

/* THE OFFER: put in front of the reader once the move is worth making (ic's `offerMove`), told once a window. */
let offerTold = false;

/** The offer is on screen. */
export const engineOfferShown = (): void => {
    if (!offerTold) {
        offerTold = true;
        track(`desktop_engine_offer`, { action: `shown` });
    }
};

// What the system's dialog asks before a move, by where it goes.
const moveQuestion = (to: MoveTarget): { readonly title: string; readonly body: string } =>
    to === `docker-desktop`
        ? { title: t(`desktop.engine.confirm.toDockerDesktopTitle`), body: t(`desktop.engine.confirm.toDockerDesktop`) }
        : { title: t(`desktop.engine.confirm.toIntenticTitle`), body: t(`desktop.engine.confirm.toIntentic`) };

/**
 * Move every sandbox to `to`, once the reader says yes in the system's own dialog. `offered` is a yes to the offer, as
 * analytics count it. Minutes long: the card follows its steps, and the page's other verbs wait for it.
 */
export const moveEngine = async (to: MoveTarget, offered: boolean): Promise<void> => {
    if (running.value || engineMoving.value !== undefined) {
        return;
    }
    const question = moveQuestion(to);
    const agreed = await confirm(question.body, { title: question.title, kind: `warning`, okLabel: t(`desktop.engine.confirm.move`) });
    // Asked again: another window, or Repair, may have started one while the dialog was up.
    if (!agreed || running.value || engineMoving.value !== undefined) {
        return;
    }
    if (offered) {
        track(`desktop_engine_offer`, { action: `accepted` });
    }
    engineMoveEnd.value = undefined;
    engineMoveError.value = undefined;
    engineCleanupNote.value = undefined;
    engineMoving.value = startMove(engineOf(to), `ours`);
    own = `running`;
    const startedAt = Date.now();
    // Asked here and awaited through `start`, which owns the run's bookkeeping, as a fix's is (fix.ts).
    const answered = engineMove(to);
    const failure = await start(MOVE_RUN, () => answered.then(() => undefined));
    const end = failure === undefined ? await answered : undefined;
    // Outcomes, a duration and a count: never a sandbox's name or a line of what ic said.
    track(`desktop_engine_move`, { to, outcome: end?.outcome ?? `failed`, seconds: Math.round((Date.now() - startedAt) / 1000), count: end?.count ?? 0 });
    if (end?.ran === true && ownNow() === `exitHeard`) {
        own = undefined;
        return;
    }
    // A move that never ran has no steps to come; one that ran still has its last ones on the way.
    own = end?.ran === true ? `answered` : undefined;
    finish(end, failure);
};

/** "Not now": the reader's word for Docker Desktop, which ic keeps, so the offer stands down. Moves nothing. */
export const declineEngineMove = async (): Promise<void> => {
    engineOfferError.value = undefined;
    track(`desktop_engine_offer`, { action: `declined` });
    try {
        await enginePrefer(`docker-desktop`);
    } catch (error) {
        engineOfferError.value = String(error);
    }
    await loadEngine();
};

/** Remove the copies moves left now, rather than once their days are up, once the reader says yes. */
export const removeEngineCopies = async (): Promise<void> => {
    if (engineCleaning.value || engineMoving.value !== undefined) {
        return;
    }
    const agreed = await confirm(t(`desktop.engine.removeCopies.body`), {
        title: t(`desktop.engine.removeCopies.title`),
        kind: `warning`,
        okLabel: t(`desktop.engine.removeCopies.remove`),
    });
    if (!agreed) {
        return;
    }
    engineCleaning.value = true;
    engineCleanupNote.value = undefined;
    try {
        await engineCleanup();
    } catch (error) {
        engineCleanupNote.value = String(error);
    }
    await loadEngine();
    engineCleaning.value = false;
    // ic leaves a copy whose engine does not answer for a later round: said, since the button did not do what it said.
    const left = keptCopiesOf(engineState.value)[0];
    if (engineCleanupNote.value === undefined && left !== undefined) {
        engineCleanupNote.value = t(`desktop.engine.copiesStay.${left.on}`);
    }
};

/** Put away how the last move ended. */
export const dismissEngineMove = (): void => {
    engineMoveEnd.value = undefined;
    engineMoveError.value = undefined;
};
