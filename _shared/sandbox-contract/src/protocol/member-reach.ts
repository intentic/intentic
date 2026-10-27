import type { AgentAccess } from "../schemas/members.js";
import { type MemberRole, roleAtLeast } from "../schemas/shared.js";
import { defaultFloor } from "./route-meta.js";
import { isAttachmentPath } from "../state/workspace-state.js";
import { sandboxRouteFor } from "../index.js";

// Role floors: the minimum trust tier each route demands, read from the route's own RouteMeta (route-meta.ts). One
// function for both sides: the daemon's bearer middleware refuses with it right after the caller's role resolves, and
// the editor asks it before sending, so a request the daemon would refuse is never sent and the two cannot disagree.
// A floor, not the whole answer: operating routes still keep their own in-route maintainer gates; membership stays
// owner-only.

// `target` is the upload's `?path=`, written by the caller: isAttachmentPath folds `..` first, so a traversal out of
// the attachments dir never buys an attachment's floor.
const attachment = (target: string | undefined): boolean => target !== undefined && isAttachmentPath(target);

// Why a member was refused, in a word the editor can act on without reading the sentence: below the route's tier,
// running agents is off for them, or a guest asking for a door not on its list.
export type MemberRefusalReason = "floor" | "agents-off" | "guest";

// The body of that refusal, as the daemon sends it and as the editor predicts it before sending.
export interface MemberRefusal {
    readonly error: string;
    readonly floor: MemberRole;
    readonly reason: MemberRefusalReason;
}

// The one refusal the bearer middleware hands a verified member: the tier a route wants, or a guest asking for a door
// not on its list. Undefined admits. `target` is the upload's `?path=`, the one route whose floor depends on where
// the bytes land.
export const memberRefusal = (
    caller: {
        readonly role: MemberRole;
        readonly areas?: readonly string[] | undefined;
        readonly agents?: AgentAccess | undefined;
        readonly lands?: true | undefined;
    },
    method: string,
    path: string,
    target?: string,
): MemberRefusal | undefined => {
    if (caller.role === "guest") {
        return guestReach(method, path, target) || homeReach(caller, method, path)
            ? undefined
            : { error: "not open to a guest member", floor: "viewer", reason: "guest" };
    }
    const floor = routeFloor(method, path, target);
    if (!roleAtLeast(caller.role, floor)) {
        return { error: `${floor} access required`, floor, reason: "floor" };
    }
    // The collaborator floor is driving agents. A person who edits files by hand without running agents holds the
    // writer tier, which clears that floor by rank: their own answer keeps them off it.
    return floor === "collaborator" && caller.agents === "off" ? { error: "running agents is not on for you here", floor, reason: "agents-off" } : undefined;
};

// Whether a guest member may reach this request at all: a route on the guest's list, or an upload into the attachments
// that ride with its own message. A route added later is closed to a guest until it says otherwise.
export const guestReach = (method: string, path: string, target?: string): boolean => {
    const meta = sandboxRouteFor(method, path)?.meta;
    return meta?.guest === true || (meta?.attachmentFloor !== undefined && attachment(target));
};

// What a home-only guest reaches beyond the guest list: the land press, when their home lands by itself (`landsHere`),
// which the route then admits on that home alone (conversations/home/home-conversation.ts refuseUnlessHome).
const homeReach = (caller: { readonly agents?: AgentAccess | undefined; readonly lands?: true | undefined }, method: string, path: string): boolean =>
    caller.agents === "home" && caller.lands === true && homeLandReach(method, path);

// Whether a route is the land press a home-only member who lands may make (route-meta.ts `home`).
export const homeLandReach = (method: string, path: string): boolean => sandboxRouteFor(method, path)?.meta.home === "land";

// `target` is the workspace path a byte-write addresses (upload's `?path=`); absent for every other route.
export const routeFloor = (method: string, path: string, target?: string): MemberRole => {
    const meta = sandboxRouteFor(method, path)?.meta;
    if (meta?.attachmentFloor !== undefined && attachment(target)) {
        return meta.attachmentFloor;
    }
    return meta?.floor ?? defaultFloor(method);
};
