import type { ModelRole } from "@intentic/sandbox-contract";

/* NOBODY SET A MODEL FOR THIS JOB, so the job does not run. Thrown by the helper walk (role-model.ts) before
 * it reads a catalog or asks an adapter.
 *
 * AN ERROR RATHER THAN A RETURN VALUE because every caller of that walk already has one road for "there is no
 * answer", and a second success shape would have to be threaded through all of them to say the same thing. A
 * CLASS rather than a sentence because this is the one refusal that is NOT a fault: a caller that logged a
 * failure for it would fill the log with a decision the owner made on purpose, and the safety gates owe a
 * different sentence for it than for a judge they genuinely could not reach.
 *
 * IN A MODULE OF ITS OWN, WHICH IS NOT FUSSINESS. `role-model.ts` reaches the adapter registry, which reaches
 * the provider registry, which reaches every provider module — and the Claude provider's hooks reach the
 * command gate, which is one of the two readers of this class. Declaring it beside the walk put the gate
 * inside that cycle, and an ESM cycle here does not fail loudly: `PROVIDER_MODULES` simply evaluates with a
 * hole in it, and the registry's own drift guard throws at import time on a list containing `undefined`. A
 * leaf module with one type import cannot join a cycle. */
export class RoleModelUnsetError extends Error {
    constructor(readonly role: ModelRole) {
        super(`No model is set for this job, so it does not run. Set one in Sandbox ▸ Agent ▸ Models.`);
        this.name = `RoleModelUnsetError`;
    }
}
