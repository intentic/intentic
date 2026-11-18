import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { attentionCards } from "../../agent-status/agentStatus-lanes";
import { unregistered } from "../../agent-status/agentStatus-standing";
import { ownedBy, sameAddress } from "../../agent-status/ownership";
import type { FleetAgent } from "../useAgents-fleet";
import { agentInProject, heldWakeInProject } from "./projectMembership";

// The narrowing the reader chose; `project` and `owner` are undefined for all of them.
export interface Scope {
    readonly project: string | undefined;
    readonly owner: string | undefined;
    readonly me: string | undefined;
    readonly roles: readonly Role[];
}

// A draft not yet sent stays under the project it was opened in, having no record to say so yet, and under Mine and
// everybody's, being about to be the reader's own; never under a colleague's chip, where it would not belong.
export const scopeFleet = (fleet: readonly FleetAgent[], { project, owner, me, roles }: Scope): FleetAgent[] => {
    const keepsDrafts = owner === undefined || sameAddress(owner, me);
    return fleet.filter(
        (agent) =>
            (unregistered(agent.status) && keepsDrafts) ||
            ((project === undefined || agentInProject(agent, project, roles)) && (owner === undefined || ownedBy(agent, owner))),
    );
};

// The rail badge counts the whole sandbox while the board shows the open project (and, if chosen, one person's work).
// This is what that narrowing keeps off the board, so the tile can say so and the Attention lane can offer it.
export interface HiddenInput {
    readonly fleet: readonly FleetAgent[];
    readonly held: readonly AutomationApproval[];
    readonly roles: readonly Role[];
    readonly project: string | undefined;
    readonly owner: string | undefined;
    readonly me: string | undefined;
}

// Items of the Attention lane (cards and held wakes, as the badge counts them) the project and owner choices keep off
// the board. Zero with neither chosen.
export const attentionHidden = ({ fleet, held, roles, project, owner, me }: HiddenInput): number => {
    if (project === undefined && owner === undefined) {
        return 0;
    }
    const kept = scopeFleet(fleet, { project, owner, me, roles });
    const keptHeld = project === undefined ? held.length : held.filter((wake) => heldWakeInProject(wake, project, roles, fleet)).length;
    return attentionCards(fleet) - attentionCards(kept) + held.length - keptHeld;
};

