import type { AgentAccess, ManageRight } from "../schemas/members.js";
import { type MemberTier, tierAtLeast } from "../schemas/shared.js";
import { defaultFloor } from "./route-meta.js";
import { isAttachmentPath } from "../state/workspace-state.js";
import { sandboxRouteFor } from "../index.js";
import type { PassScope } from "./doors/pass-scopes.js";

// Role floors: the minimum trust tier each route demands, read from the route's own RouteMeta (route-meta.ts). One
// function for both sides: the daemon's bearer middleware refuses with it right after the caller's tier resolves, and
// the editor asks it before sending, so a request the daemon would refuse is never sent and the two cannot disagree.
// A floor, not the whole answer: operating routes still keep their own in-route gates (members.ts `holdsRight`,
// `peopleChangeRefusal`). A route that runs one part of the sandbox names it (`right`), and a person given that part
// clears its floor whatever their tier.

// `target` is the upload's `?path=`, written by the caller: isAttachmentPath folds `..` first, so a traversal out of
// the attachments dir never buys an attachment's floor.
const attachment = (target: string | undefined): boolean => target !== undefined && isAttachmentPath(target);

// Why a member was refused, in a word the editor can act on without reading the sentence: below the route's tier,
// running agents is off for them, or a guest asking for a door not on its list.
export type MemberRefusalReason = "floor" | "agents-off" | "guest";

// The body of that refusal, as the daemon sends it and as the editor predicts it before sending.
export interface MemberRefusal {
    readonly error: string;
    readonly floor: MemberTier;
    readonly reason: MemberRefusalReason;
}

// The one refusal the bearer middleware hands a verified member: the tier a route wants, or a guest asking for a door
// not on its list. Undefined admits. `target` is the upload's `?path=`, the one route whose floor depends on where
// the bytes land.
export const memberRefusal = (
    caller: {
        readonly tier: MemberTier;
        readonly areas?: readonly string[] | undefined;
        readonly agents?: AgentAccess | undefined;
        readonly lands?: true | undefined;
        readonly manages?: readonly ManageRight[] | undefined;
    },
    method: string,
    path: string,
    target?: string,
): MemberRefusal | undefined => {
    if (caller.tier === "guest") {
        return guestReach(method, path, target) || homeReach(caller, method, path)
            ? undefined
            : { error: "not open to a guest member", floor: "viewer", reason: "guest" };
    }
    const floor = routeFloor(method, path, target);
    if (!tierAtLeast(caller.tier, floor) && !givenRight(caller, method, path)) {
        return { error: `${floor} access required`, floor, reason: "floor" };
    }
    // The collaborator floor is driving agents. A person who edits files by hand without running agents holds the
    // writer tier, which clears that floor by rank: their own answer keeps them off it.
    return floor === "collaborator" && caller.agents === "off" ? { error: "running agents is not on for you here", floor, reason: "agents-off" } : undefined;
};

// The caller's fields every floor reads, as memberRefusal takes them.
type ReachCaller = Parameters<typeof memberRefusal>[0];

// WHAT A PERSON ROUTED FROM ANOTHER SANDBOX MAY DO HERE (2026-11-24, docs/architecture/account-routing.md), one rule per
// pass scope, beside memberRefusal so the editor can say before sending what the receiving daemon will answer. Undefined
// admits. `wake` is a drop that asks to be queued into one of the person's conversations, which starts a turn.
// - report: anyone on the roster, a guest included: the person is attribution only, and a report starts nothing they own;
// - drop: collaborator and up, never a guest. Not memberRefusal's floor, whose agents-off rule would refuse a writer who
//   edits by hand, and a drop runs no agent; one that wakes a conversation is driving one, so it takes that floor too;
// - read: viewer and up, a guest included, since the reader cuts what they see to what they may read here;
// - task: whoever may start a turn here. A guest is named apart, as is a home-only member: both reach `POST /agent` on the
//   guest list (member-reach.test.ts), for their own chat or home, never a conversation another sandbox opens for them.
export const scopeRefusal = (caller: ReachCaller, scope: PassScope, options: { readonly wake?: boolean } = {}): MemberRefusal | undefined => {
    switch (scope) {
        case "report":
        case "read":
            return undefined;
        case "drop": {
            if (caller.tier === "guest" || !tierAtLeast(caller.tier, "collaborator")) {
                return { error: "dropping into this sandbox needs collaborator access here", floor: "collaborator", reason: caller.tier === "guest" ? "guest" : "floor" };
            }
            return options.wake === true ? taskRefusal(caller) : undefined;
        }
        case "task":
            return taskRefusal(caller);
    }
};

// Starting a turn here for a person another sandbox routes: the chat's own floor, a guest and a home-only member aside.
const taskRefusal = (caller: ReachCaller): MemberRefusal | undefined => {
    if (caller.tier === "guest") {
        return { error: "not open to a guest member", floor: "collaborator", reason: "guest" };
    }
    if (caller.agents === "home") {
        return { error: "running agents here is limited to your own home conversation", floor: "collaborator", reason: "agents-off" };
    }
    return memberRefusal(caller, "POST", "/agent");
};

// Whether the caller was given the part of the sandbox this route runs (route-meta.ts `right`).
const givenRight = (caller: { readonly manages?: readonly ManageRight[] | undefined }, method: string, path: string): boolean => {
    const right = sandboxRouteFor(method, path)?.meta.right;
    return right !== undefined && (caller.manages?.includes(right) ?? false);
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
export const routeFloor = (method: string, path: string, target?: string): MemberTier => {
    const meta = sandboxRouteFor(method, path)?.meta;
    if (meta?.attachmentFloor !== undefined && attachment(target)) {
        return meta.attachmentFloor;
    }
    return meta?.floor ?? defaultFloor(method);
};
