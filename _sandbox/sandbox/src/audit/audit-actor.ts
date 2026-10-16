import type { AuditActor } from "@intentic/sandbox-contract/schemas/audit";
import type { Caller } from "../auth/auth.js";
import type { Principal } from "../auth/principal.js";

// Who a request acts as, for its audit record: the member the daemon verified, else the control token that admitted it.
// Neither is a call from inside the sandbox (the agent's CLIs, a panel, a loopback daemon nobody signs in to), which
// is the sandbox's own credential acting, and is named as such rather than as a person.
export const actorOfCaller = (identity: Caller | undefined, principal: Principal | undefined): AuditActor => {
    if (identity !== undefined) {
        return { kind: "member", email: identity.email.toLowerCase(), role: identity.role };
    }
    if (principal !== undefined) {
        return { kind: "token", id: principal.id, label: principal.label };
    }
    return { kind: "system", reason: "sandbox credential" };
};
