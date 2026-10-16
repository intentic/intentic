import type { ModelRole } from "@intentic/sandbox-contract/models/model-roles";
import type { InjectionKey } from "vue";

// What the page knows about a job that its chip says beside its name, provided once by the page rather than threaded
// through every setup card: the judge switched off under Safety, the router carrying guidance.
export interface JobNote {
    readonly text: string;
    /** Drawn faded: the job is not in use, though it can still be moved. */
    readonly dim: boolean;
}

export interface JobState {
    readonly note: (role: ModelRole) => JobNote | undefined;
}

export const JOB_STATE: InjectionKey<JobState> = Symbol(`jobState`);
