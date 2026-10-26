import type { LocalHost } from "@intentic/web/local-host";
import type { ProcessAction, ProcessKind, ProcessReport } from "@intentic/web/process-report";
import { ref } from "vue";
import { onProcessAct, onProcesses, processAct, processClear, processesList, processReport, type ProcessActEvent } from "./desktopProcesses";

// THE APP'S PROCESSES, AS THIS BUNDLE TAKES PART IN THEM (2026-10-26; src-tauri/src/processes.rs, the web's
// processReport.ts). Every window hears the one list both faces draw, for its rail's tiles and its pages (the host's
// `processes`). The main window also drives runs (a sandbox's setup, this PC's own, a Docker start, a sync, a fix, a
// recreate, a move between engines): each reports itself here as it changes, and answers the reader's acts on it,
// given in either face, through `answering`. Nothing here moves the reader anywhere: a run that needs them says so in
// its report, and the app asks for their eye (processes.rs `attend`).

/* THE LIST, for this window's rail and pages. */

// allow(module-state): the app's list as this window last heard it
const list = ref<readonly ProcessReport[]>([]);
let following: Promise<void> | undefined;

const follow = (): Promise<void> =>
    (following ??= (async () => {
        await onProcesses((reports) => {
            list.value = reports;
        });
        try {
            list.value = await processesList();
        } catch (error) {
            console.error(`[processes] the list could not be read:`, error);
        }
    })());

/** This window's door onto the list: what the rail and the pages draw, and the reader's answers. */
export const processesHost = (): NonNullable<LocalHost[`processes`]> => {
    void follow();
    return {
        list,
        act: (id: string, act: ProcessAction, need?: string) => processAct(id, act, need),
    };
};

/* A RUN THIS WINDOW DRIVES, reported as it changes. */

// What each run was last told as, without its clock: a report that says nothing new is not sent again.
const told = new Map<string, string>();
const sameAs = (report: ProcessReport): string => JSON.stringify({ ...report, at: undefined });

/** A run's news, sent to the app's list when it is news. */
export const reportProcess = (report: ProcessReport): void => {
    const said = sameAs(report);
    if (told.get(report.id) === said) {
        return;
    }
    told.set(report.id, said);
    void send(report);
};

const send = async (report: ProcessReport): Promise<void> => {
    try {
        await processReport({ ...report, at: Date.now() });
    } catch (error) {
        console.error(`[processes] ${report.id} was not reported:`, error);
    }
};

/** A run gone from the list: ended and seen, or given up. */
export const clearProcess = (id: string): void => {
    if (!told.delete(id)) {
        return;
    }
    void unsend(id);
};

const unsend = async (id: string): Promise<void> => {
    try {
        await processClear(id);
    } catch (error) {
        console.error(`[processes] ${id} was not cleared:`, error);
    }
};

/** A run's report, or its absence, kept in step: the shape a run's own computed answers. */
export const tellProcess = (id: string, report: ProcessReport | undefined): void => {
    if (report === undefined) {
        clearProcess(id);
        return;
    }
    reportProcess(report);
};

/** A report of this app's own, with nothing said yet beyond what it is and how it stands. */
export const processOf = (kind: ProcessKind, about: string, state: ProcessReport[`state`]): ProcessReport => ({
    id: `${kind}:${about}`,
    kind,
    state,
    origin: `app`,
});

/* THE READER'S ANSWERS to the runs this window drives, from either face. */

type Answer = (act: ProcessAction, asked: ProcessActEvent) => void | Promise<void>;
const owners = new Map<ProcessKind, Answer>();

/** The answers to every run of `kind` this window drives. */
export const answering = (kind: ProcessKind, answer: Answer): void => {
    owners.set(kind, answer);
};

/** Who answers an act, by the run's id's kind, among the kinds this window answers. Pure. */
export const kindOf = (id: string): ProcessKind | undefined => [...owners.keys()].find((kind) => id.startsWith(`${kind}:`));

const answer = async (asked: ProcessActEvent): Promise<void> => {
    const kind = kindOf(asked.id);
    const owner = kind === undefined ? undefined : owners.get(kind);
    if (owner === undefined) {
        console.warn(`[processes] nobody here answers ${asked.id}`);
        return;
    }
    try {
        await owner(asked.act, asked);
    } catch (error) {
        console.error(`[processes] ${asked.id} could not ${asked.act}:`, error);
    }
};

let listening: Promise<void> | undefined;

/** The main window hears the answers to its runs (src-tauri/src/processes.rs `act` sends them only there). Once. */
export const listenForAnswers = (): Promise<void> =>
    (listening ??= (async () => {
        await onProcessAct((asked) => void answer(asked));
    })());
