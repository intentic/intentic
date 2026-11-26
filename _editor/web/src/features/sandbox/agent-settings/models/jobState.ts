import type { ModelRole, ModelRoleEntry } from "@intentic/sandbox-contract/models/model-roles";
import type { InjectionKey } from "vue";

// What the page knows about a job, provided once by the page rather than threaded through every setup card: what it is
// (the served list), and what its chip says beside its name: the judge switched off under Safety, the router carrying
// guidance.
export interface JobNote {
    readonly text: string;
    /** Drawn faded: the job is not in use, though it can still be moved. */
    readonly dim: boolean;
}

export interface JobState {
    readonly note: (role: ModelRole) => JobNote | undefined;
    /** The job as the daemon serves it (useModelRoles.ts): its words, icon, kind and suggested setup. */
    readonly spec: (role: ModelRole) => ModelRoleEntry | undefined;
}

export const JOB_STATE: InjectionKey<JobState> = Symbol(`jobState`);
