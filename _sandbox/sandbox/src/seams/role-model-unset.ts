import type { ModelRole } from "@intentic/sandbox-contract";

// Not a fault: nobody set a model for this role. Thrown by agent/models/role-model.ts before it reaches a catalog or an
// adapter, and told apart from a model that failed by every gate that asks a role's model for a verdict
// (guard/command-guard.ts, hosts/host-command-guard.ts).
export class RoleModelUnsetError extends Error {
    constructor(readonly role: ModelRole) {
        super(`No model is set for this job, so it does not run. Set one in Sandbox ▸ Agent ▸ Models.`);
        this.name = `RoleModelUnsetError`;
    }
}
