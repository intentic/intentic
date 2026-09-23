import type { MemberRole } from "@intentic/sandbox-contract";
import { isAttachmentPath, roleAtLeast, sandboxRouteFor } from "@intentic/sandbox-contract";

// Role floors: the minimum trust tier each route demands, read from the route's own RouteMeta (sandbox-contract
// route-meta.ts) by the bearer middleware right after the caller's role resolves. A floor, not the whole answer:
// operating routes still keep their own in-route maintainer gates; membership stays owner-only.

// An undeclared floor: a read floors at viewer and anything else at maintainer, so a route nobody classified can
// under-serve, never over-grant.
const methodFloor = (method: string): MemberRole => (method === "GET" || method === "HEAD" ? "viewer" : "maintainer");

// `target` is the upload's `?path=`, written by the caller: isAttachmentPath folds `..` first, so a traversal out of
// the attachments dir never buys an attachment's floor.
const attachment = (target: string | undefined): boolean => target !== undefined && isAttachmentPath(target);

// The one refusal the bearer middleware hands a verified member: the tier a route wants, or a guest asking for a door
// not on its list. Undefined admits. `target` is the upload's `?path=`, the one route whose floor depends on where
// the bytes land.
export const memberRefusal = (
    caller: { readonly role: MemberRole; readonly areas?: readonly string[] | undefined },
    method: string,
    path: string,
    target?: string,
): { readonly error: string; readonly floor: MemberRole } | undefined => {
    if (caller.role === "guest") {
        return guestReach(method, path, target) ? undefined : { error: "not open to a guest member", floor: "viewer" };
    }
    const floor = routeFloor(method, path, target);
    return roleAtLeast(caller.role, floor) ? undefined : { error: `${floor} access required`, floor };
};

// Whether a guest member may reach this request at all: a route on the guest's list, or an upload into the attachments
// that ride with its own message. A route added later is closed to a guest until it says otherwise.
export const guestReach = (method: string, path: string, target?: string): boolean => {
    const meta = sandboxRouteFor(method, path)?.meta;
    return meta?.guest === true || (meta?.attachmentFloor !== undefined && attachment(target));
};

// `target` is the workspace path a byte-write addresses (upload's `?path=`); absent for every other route.
export const routeFloor = (method: string, path: string, target?: string): MemberRole => {
    const meta = sandboxRouteFor(method, path)?.meta;
    if (meta?.attachmentFloor !== undefined && attachment(target)) {
        return meta.attachmentFloor;
    }
    return meta?.floor ?? methodFloor(method);
};
