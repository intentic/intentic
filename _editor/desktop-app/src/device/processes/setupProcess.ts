import type { ProcessAction, ProcessReport } from "@intentic/web/process-report";
import { shallowRef } from "vue";
import type { Requirement, SetupArgs, SetupReport } from "../../desktop";

// A SANDBOX'S SETUP ON THIS COMPUTER AS A PROCESS (2026-10-26): what setup.ts's run is, told to the app's one list both
// faces draw (src-tauri/src/processes.rs), with what the reader can do about it from wherever they are. The workspace
// page's own bar still hears the setup's report as it always did (`setupProgress`); this is the same run in the shape
// the rail's tile and the process's page read.

/** What setup.ts knows about its run, read once per change. */
export interface SetupFacts {
    readonly args: SetupArgs | undefined;
    /** The run as the workspace's bar hears it (setup.ts `report`); undefined while there is none to tell. */
    readonly report: SetupReport | undefined;
    /** What this computer needs first, while the card asks it. */
    readonly requirements: readonly Requirement[];
    readonly requirementsShown: boolean;
    /** The code ran out and no fresh one could be had by itself. */
    readonly expired: boolean;
    /** Why it stopped, in the run's own words. */
    readonly failure: string | undefined;
}

/** The run's id: the sandbox it makes. One setup at a time here, so a setup that names no sandbox is "here". */
export const setupProcessId = (args: SetupArgs | undefined): string => {
    const id = args?.sandboxId;
    return `sandbox-setup:${id !== undefined && /^\S+$/.test(id) && id !== `` ? id : `here`}`;
};

// What can be done about it, by how it stands; the first is the main press.
const actionsOf = (report: SetupReport, expired: boolean): readonly ProcessAction[] => {
    switch (report.state) {
        case `running`:
            return [`stop`];
        case `waiting`:
            switch (report.waitingFor) {
                case `restart`:
                    return [`restart-now`, `use-hosted`, `dismiss`];
                case `signOut`:
                    return [`sign-out`, `use-hosted`, `dismiss`];
                case `pcSetup`:
                    return [`use-hosted`, `dismiss`];
                default:
                    return [`consent`, `use-hosted`, `dismiss`];
            }
        case `failed`:
            return expired ? [`fresh-code`, `use-hosted`, `dismiss`] : [`retry`, `use-hosted`, `dismiss`];
        case `stopped`:
            return [`retry`, `dismiss`];
        case `done`:
            return [`open`, `dismiss`];
        case `closed`:
            return [];
    }
};

/** The run as a process, or nothing while there is none (a card put away, a run handed to a machine of ours). Pure. */
export const setupProcessOf = (facts: SetupFacts): ProcessReport | undefined => {
    const { args, report } = facts;
    if (args === undefined || report === undefined || report.state === `closed`) {
        return undefined;
    }
    const given = (value: string | undefined): value is string => value !== undefined && value !== ``;
    const waiting = report.state === `waiting`;
    // Absent words are undefined, which the app's list never receives (JSON drops them).
    const said = (value: string | undefined): string | undefined => (given(value) ? value : undefined);
    return {
        id: setupProcessId(args),
        kind: `sandbox-setup`,
        state: report.state,
        origin: `app`,
        percent: report.percent,
        actions: actionsOf(report, facts.expired),
        subject: said(args.name),
        sandboxId: said(args.sandboxId),
        position: said(report.position),
        remaining: said(report.remaining),
        step: said(report.step),
        waitingFor: waiting ? report.waitingFor : undefined,
        failure: report.state === `failed` ? said(facts.failure)?.slice(0, 600) : undefined,
        needs:
            waiting && facts.requirementsShown
                ? facts.requirements.map((requirement) => ({ id: requirement.id, label: requirement.title, detail: requirement.problem }))
                : undefined,
    } satisfies ProcessReport;
};

/** A setup that finished here: on both faces' rails, with its Open, until the reader opens or puts it away. */
// allow(module-state): the one finished setup of this window, which outlives its run
export const finishedSetup = shallowRef<ProcessReport | undefined>(undefined);

/** Setups handed to a machine of ours (setup.ts `setUpElsewhere`): that machine's to tell from then on (new_sandbox.rs). */
// allow(module-state): which runs this window has stopped telling
export const handedToHosted = new Set<string>();
