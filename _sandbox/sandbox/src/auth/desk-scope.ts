import type { SystemEvent } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { Caller } from "./auth.js";

// What a desk member may see of the fleet: the conversations they own or started, and nothing else. Every other tier
// sees the fleet whole, which is what the board's Everyone/Mine row is for. A desk's narrowing is not a preference:
// the transcript of someone else's all-access conversation is the brain in prose.

// The two provenance fields every registry shape carries, which is all this needs to read.
export interface Provenance {
    readonly startedBy?: string | undefined;
    readonly owner?: { readonly email: string } | undefined;
}

const sameEmail = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// Whether the caller may see this conversation. Undefined identity is the owner's own tool (a panel, loopback), which
// sees everything.
export const visibleTo = (caller: Caller | undefined, agent: Provenance): boolean => {
    if (caller === undefined || caller.role !== "desk") {
        return true;
    }
    return (agent.owner !== undefined && sameEmail(agent.owner.email, caller.email)) || (agent.startedBy !== undefined && sameEmail(agent.startedBy, caller.email));
};

// The refusal a desk meets on someone else's conversation. Unnamed on purpose: whose it is would say what the desk
// may not know.
export const refuseUnlessVisible = (caller: Caller | undefined, agent: Provenance): void => {
    if (!visibleTo(caller, agent)) {
        throw new ORPCError("FORBIDDEN", { message: "not one of your conversations" });
    }
};

// A desk may act only through the cards it holds; naming none is refused too, since an unpinned attended chat reaches
// every account, which is exactly what a desk is not handed.
export const refuseUnlessHeld = (caller: Caller | undefined, actsAs: string | undefined): void => {
    if (caller === undefined || caller.role !== "desk") {
        return;
    }
    const held = caller.desks ?? [];
    if (actsAs === undefined || !held.includes(actsAs)) {
        throw new ORPCError("FORBIDDEN", {
            message: actsAs === undefined ? `a desk speaks through one of its personas: ${held.join(", ")}` : `"${actsAs}" is not one of your personas: ${held.join(", ")}`,
        });
    }
};

// Which persona ids a desk holds; undefined for every other tier, meaning no narrowing.
export const heldPersonas = (caller: Caller | undefined): ReadonlySet<string> | undefined =>
    caller !== undefined && caller.role === "desk" ? new Set(caller.desks ?? []) : undefined;

// What a desk's event stream carries: the roster narrowed to its own conversations, and nothing that names a path or
// a repository. Undefined drops the frame.
export const deskEvent = (caller: Caller | undefined, event: SystemEvent): SystemEvent | undefined => {
    if (caller === undefined || caller.role !== "desk") {
        return event;
    }
    switch (event.kind) {
        case "agents": {
            return { ...event, agents: event.agents.filter((agent) => visibleTo(caller, agent)) };
        }
        case "workspaceChanged":
        case "derivedChanged":
        case "reposChanged":
        case "refsChanged": {
            return undefined;
        }
        default: {
            return event;
        }
    }
};
