import type { ModelRole } from "@intentic/sandbox-contract";

// Not a fault: nobody set a model for this role, thrown before role-model.ts reaches a catalog or adapter. Stays in its
// own module to avoid an ESM import cycle with the command gate that also reads it.
export class RoleModelUnsetError extends Error {
    constructor(readonly role: ModelRole) {
        super(`No model is set for this job, so it does not run. Set one in Sandbox ▸ Agent ▸ Models.`);
        this.name = `RoleModelUnsetError`;
    }
}
