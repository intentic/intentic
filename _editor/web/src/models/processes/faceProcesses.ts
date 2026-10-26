import { computed, type Ref, ref, shallowRef } from "vue";
import { desktopTakesProcesses, openDesktopLink } from "../../app/environments/desktop";
import { localFace } from "../../app/environments/local";
import { localHost } from "../../app/environments/localHost";
import {
    DESKTOP_PROCESS_ACT_EVENT,
    DESKTOP_PROCESS_HELLO_LINK,
    DESKTOP_PROCESSES_EVENT,
    desktopProcessActLink,
    desktopProcessClearLink,
    desktopProcessLink,
    type ProcessAction,
    processActOf,
    type ProcessReport,
    processesOf,
} from "../../app/environments/processes/processReport";

// THE PROCESSES A FACE DRAWS, from wherever that face hears them (processReport.ts says what a process is). The
// workspace hears the app's list by event, once it has said hello, and holds runs of its own (a machine of ours started
// from Home), which it tells the app so This computer draws them too, and answers when This computer acts on one. A local
// window reads the same list from its host. Either way a press goes back to whoever runs the process: the app by link or
// by its host, or the page that holds it.

type Act = (act: ProcessAction, need?: string) => void;

export interface FaceProcesses {
    /** Every process the app knows of, newest report each; empty in a browser and in an app from before the list. */
    readonly list: Readonly<Ref<readonly ProcessReport[]>>;
    /** A press on one: sent to whoever runs it. */
    readonly act: (report: ProcessReport, act: ProcessAction, need?: string) => void;
}

/* THE WORKSPACE'S SIDE. */

// allow(module-state): the app's list as this page last heard it, one per page
const heard = shallowRef<readonly ProcessReport[]>([]);
// allow(module-state): the runs this page holds, by id, and what answers a press on each
const held = new Map<string, Act>();
// allow(module-state): whether this page listens yet; the first face to ask starts it, once
const listening = ref(false);

const listen = (): void => {
    if (listening.value || !desktopTakesProcesses()) {
        return;
    }
    listening.value = true;
    // The app repeats its list while anything runs (its heartbeat), each time freshly stamped: only a list that says
    // something new is taken, so the rail is not redrawn under the reader's pointer every few seconds for nothing.
    let said = `[]`;
    window.addEventListener(DESKTOP_PROCESSES_EVENT, (event) => {
        const list = processesOf(event);
        const now = list === undefined ? said : JSON.stringify(list.map(({ at: _at, ...rest }) => rest));
        if (list !== undefined && now !== said) {
            said = now;
            heard.value = list;
        }
    });
    // This computer answering a run this page holds: the same press as the page's own.
    window.addEventListener(DESKTOP_PROCESS_ACT_EVENT, (event) => {
        const answer = processActOf(event);
        if (answer !== undefined) {
            held.get(answer.id)?.(answer.act, answer.need);
        }
    });
    openDesktopLink(DESKTOP_PROCESS_HELLO_LINK);
};

const actFromWorkspace = (report: ProcessReport, act: ProcessAction, need?: string): void => {
    const own = held.get(report.id);
    if (own !== undefined) {
        own(act, need);
        return;
    }
    if (desktopTakesProcesses()) {
        openDesktopLink(desktopProcessActLink(report.id, act, need));
    }
};

/**
 * A run this page holds, told to the app as it changes (so This computer draws it) and answered by `onAct` whichever
 * face the press was on. Returns the way to let it go, which clears it from the app's list too.
 */
export interface HeldProcess {
    /** Tells the app the run as it stands now; the same report twice is said once. */
    readonly tell: (report: ProcessReport) => void;
    /** The run is over here: off the app's list, and no longer answered. */
    readonly release: () => void;
}

export const holdProcess = (id: string, onAct: Act): HeldProcess => {
    held.set(id, onAct);
    let told = ``;
    return {
        tell: (report) => {
            const said = JSON.stringify(report);
            if (said === told || !desktopTakesProcesses()) {
                return;
            }
            told = said;
            openDesktopLink(desktopProcessLink(report));
        },
        release: () => {
            if (held.get(id) !== onAct) {
                return;
            }
            held.delete(id);
            if (told !== `` && desktopTakesProcesses()) {
                openDesktopLink(desktopProcessClearLink(id));
            }
        },
    };
};

/* A LOCAL WINDOW'S SIDE: its host's list, the same one. */

const EMPTY = shallowRef<readonly ProcessReport[]>([]);

/** The processes this face draws and the way to answer them, from the face's own channel. */
export const useFaceProcesses = (): FaceProcesses => {
    if (localFace() !== undefined) {
        const host = localHost().processes;
        return {
            list: host?.list ?? EMPTY,
            act: (report, act, need) => void host?.act(report.id, act, need),
        };
    }
    listen();
    return { list: computed(() => heard.value), act: actFromWorkspace };
};
