import type { IntenticOsChannel, IntenticOsStatus, IntenticOsUpdateCheck } from "@intentic/sandbox-contract/schemas/intentic-os";
import { t } from "@intentic/ui/i18n";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ref } from "vue";
import { track } from "../../analytics";
import { revealLog } from "../../desktop";
import { osChannel, osReboot, osRollback, osStatus, osUpdate, osUpdateCheck, type OsRunEnd, type OsRunEvent, type OsVerb } from "../../desktopOs";
import { running, start } from "../runs";
import { endOf, foldRun, startRun, waitingVersionOf, type OsRestart, type OsRunProgress } from "./systemCard";

// THIS SYSTEM (src-tauri/src/os.rs runs the OS's own `ic os`): what Intentic OS says of itself, read when a window
// starts, when This device opens, now and then while it is on screen, and after every change; and the changes the
// reader makes here, each asked about first in the system's own dialog where it restarts this computer or changes what
// its next boot runs. Every window hears every change's lines (`desktop://os-run`), whichever started it. The card
// draws it (SystemCard.vue); on a computer that is not Intentic OS there is nothing here and no card.

/** What ic last said of this system; undefined on a computer that is not Intentic OS, and until ic has said. */
export const osState = ref<IntenticOsStatus | undefined>(undefined);
/** A change under way: this window's own, or one another window started. */
export const osRun = ref<OsRunProgress | undefined>(undefined);
/** How the last change this window followed ended, until the reader puts it away or another begins. */
export const osRunEnd = ref<OsRunEnd | undefined>(undefined);
/** A change this window asked for that never ran (the OS's ic missing), in the app's words. */
export const osRunError = ref<string | undefined>(undefined);
/** What the last check for updates found. */
export const osCheck = ref<IntenticOsUpdateCheck | undefined>(undefined);
export const osChecking = ref(false);
export const osCheckError = ref<string | undefined>(undefined);
/** The transcript of a change that did not finish, in the machine's own file manager. */
export const showOsLog = (path: string): void => {
    revealLog(path).catch((error) => console.error(`[device] the system change's log could not be shown:`, error));
};

// Each change streams under a run of its own (os.rs `Verb::run`), which the page's other verbs wait for.
const RUN_OF = { update: `os-update`, rollback: `os-rollback`, channel: `os-channel`, reboot: `os-reboot` } as const satisfies Record<OsVerb, string>;

/* Only the newest read writes: an answer from before a change ended would put the old state back on screen. */
let reads = 0;
let readAt = 0;

/** Ask ic again what this system is. No answer (ic did not answer this once) leaves what was last known. */
export const loadOs = async (): Promise<void> => {
    reads += 1;
    const read = reads;
    let status: IntenticOsStatus | null;
    try {
        status = await osStatus();
    } catch (error) {
        console.error(`[device] this system's status could not be read:`, error);
        return;
    }
    if (read !== reads) {
        return;
    }
    readAt = Date.now();
    osState.value = status ?? undefined;
};

/** How often the page's timer reads the status again: each read is a `sudo bootc status`, which the system logs. */
export const OS_REREAD_MS = 5 * 60_000;

/** The page's timer: the status again once it is old, and at every tick while the boot's health is still to be judged
 *  (greenboot waits up to ten minutes for every sandbox to come back). Nothing on a computer that is not Intentic OS. */
export const followOs = (now = Date.now()): void => {
    const status = osState.value;
    if (status !== undefined && osRun.value === undefined && (status.health.verdict === `unknown` || now - readAt >= OS_REREAD_MS)) {
        void loadOs();
    }
};

// The verb of this window's own change once its answer is in: what is still on its way of that run (its last lines, its
// exit) says nothing the answer did not, and must not put a finished run back on screen. A run's `started` clears it.
let answered: OsVerb | undefined;

/** One moment of a change, from whichever window started it (`desktop://os-run`). */
export const hearOsRun = (event: OsRunEvent): void => {
    if (event.kind === `started`) {
        answered = undefined;
        osRunEnd.value = undefined;
        osRunError.value = undefined;
    } else if (event.verb === answered) {
        if (event.kind === `exit`) {
            answered = undefined;
        }
        return;
    }
    const end = endOf(event);
    osRun.value = foldRun(osRun.value, event);
    if (end !== undefined) {
        osRunEnd.value = end;
        void loadOs();
    }
};

interface Question {
    readonly title: string;
    readonly body: string;
    readonly ok: string;
}

/**
 * Run one change, once the reader says yes where there is a `question`. Minutes long for a download: the card follows its
 * lines, and the page's other verbs wait for it.
 */
const change = async (verb: OsVerb, apply: boolean, ask: () => Promise<OsRunEnd>, question?: Question, channel?: IntenticOsChannel): Promise<void> => {
    if (running.value || osRun.value !== undefined) {
        return;
    }
    if (question !== undefined) {
        const agreed = await confirm(question.body, { title: question.title, kind: `warning`, okLabel: question.ok });
        // Asked again: another window may have started a change while the dialog was up.
        if (!agreed || running.value || osRun.value !== undefined) {
            return;
        }
    }
    osRunEnd.value = undefined;
    osRunError.value = undefined;
    const mine = startRun(verb, apply, channel);
    osRun.value = mine;
    const startedAt = Date.now();
    // Asked here and awaited through `start`, which owns the run's bookkeeping, as a move's is (../engine.ts).
    const asked = ask();
    const failure = await start(RUN_OF[verb], () => asked.then(() => undefined));
    const end = failure === undefined ? await asked : undefined;
    // Outcomes and a duration: never a line of what ic said.
    track(`desktop_os_change`, { verb, apply, outcome: end?.outcome ?? `failed`, seconds: Math.round((Date.now() - startedAt) / 1000) });
    if (end?.ran === false && osRun.value !== mine) {
        // Refused because another change ran: that one goes on, as this window's reading of it.
        osRunEnd.value = end;
        return;
    }
    if (end?.ran === true && osRun.value !== undefined) {
        answered = verb;
    }
    osRun.value = undefined;
    osRunEnd.value = end;
    osRunError.value = failure;
    await loadOs();
};

/** Restart this computer into what waits for its next boot: every sandbox restarts with it, its turns resumed after. */
export const restartOs = (restart: OsRestart): Promise<void> => {
    const version = osState.value === undefined ? undefined : waitingVersionOf(osState.value);
    const question = (body: string): Question => ({ title: t(`desktop.os.confirm.restartTitle`), body, ok: t(`desktop.os.confirm.restart`) });
    return restart === `applyUpdate`
        ? change(`update`, true, () => osUpdate(true), question(t(`desktop.os.confirm.restartUpdate`)))
        : change(
              `reboot`,
              true,
              osReboot,
              question(version === undefined ? t(`desktop.os.confirm.restartRollback`) : t(`desktop.os.confirm.restartRollbackTo`, { version })),
          );
};

/** Download the newer version a check found and stage it for the next boot. Nothing restarts, so nothing is asked. */
export const downloadOsUpdate = (): Promise<void> => change(`update`, false, () => osUpdate(false));

/** Queue the previous version for the next boot, once the reader says yes. Nothing restarts yet. */
export const rollBackOs = (): Promise<void> => {
    const version = osState.value?.rollback?.version ?? undefined;
    return change(`rollback`, false, () => osRollback(false), {
        title: version === undefined ? t(`desktop.os.confirm.rollbackTitle`) : t(`desktop.os.confirm.rollbackTitleTo`, { version }),
        body: t(`desktop.os.confirm.rollback`),
        ok: t(`desktop.os.confirm.rollBack`),
    });
};

/** Stage this edition from the other channel for the next boot, once the reader says yes. */
export const switchOsChannel = (channel: IntenticOsChannel): Promise<void> =>
    change(
        `channel`,
        false,
        () => osChannel(channel),
        { title: t(`desktop.os.confirm.channelTitle.${channel}`), body: t(`desktop.os.confirm.channel.${channel}`), ok: t(`desktop.os.confirm.switch`) },
        channel,
    );

/** Ask the image's registry whether a newer version is out on this channel. Downloads nothing. */
export const checkOsUpdate = async (): Promise<void> => {
    if (osChecking.value) {
        return;
    }
    osChecking.value = true;
    osCheckError.value = undefined;
    try {
        osCheck.value = await osUpdateCheck();
    } catch (error) {
        osCheck.value = undefined;
        osCheckError.value = String(error);
    } finally {
        osChecking.value = false;
    }
};

/** Put away how the last change ended. */
export const dismissOsRun = (): void => {
    osRunEnd.value = undefined;
    osRunError.value = undefined;
};
