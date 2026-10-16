import type { askRoleModel, roleModelIsSet } from "../agent/models/role-model.js";
import type { cancelFamily, familyOf } from "../agent/subagents/children.js";
import type { cancelWatchersFor } from "../agent/verification/watchers.js";

// What the fleet asks of the turn engine besides its turns (turn-starter.ts), bound by composition so conversations never
// import the engine: a land's subject from the role model, and the children and watches a conversation leaving ends.
export interface TurnEngine {
    readonly askRoleModel: typeof askRoleModel;
    readonly roleModelIsSet: typeof roleModelIsSet;
    readonly familyOf: typeof familyOf;
    readonly cancelFamily: typeof cancelFamily;
    readonly cancelWatchersFor: typeof cancelWatchersFor;
}
