import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import { memberAccess } from "@intentic/sandbox-contract/schemas/members";
import type { Service } from "@intentic/sandbox-contract/schemas/services";
import type { Member } from "../auth/auth.js";

/* WHETHER A SERVICE MAY STILL RUN, asked before unattended work starts a turn as it (docs/architecture/access.md).
   A service acts for its steward, so one whose steward left the roster (or no longer runs agents here), whose own record
   is gone, or whose profile is gone would reach nothing: its run is skipped with the reason instead, where the owner reads
   it on the automation's history or the link's task, rather than started and refused at every exit.
   The answer also carries the fence its run is born inside: the steward's areas held under the profile's, as area ids,
   since that is how a conversation's fence is latched (conversations/actor/identity-latch.ts). */

export type ServiceStanding =
    | { readonly ok: true; readonly service: Service; readonly areas?: readonly string[] }
    | { readonly ok: false; readonly reason: string };

export interface ServiceStandingDeps {
    readonly services: { readonly get: (id: string) => Promise<Service | undefined> };
    readonly accessProfiles: { readonly get: (id: string) => Promise<AccessProfile | undefined> };
    readonly members: { readonly list: () => Promise<readonly Member[]> };
    readonly ownerEmail: () => Promise<string | undefined>;
}

const lower = (email: string): string => email.toLowerCase();

// Two fences as area ids, held together: undefined is the whole workspace, so it gives way to the other.
const narrower = (left: readonly string[] | undefined, right: readonly string[] | undefined): readonly string[] | undefined => {
    if (left === undefined) {
        return right;
    }
    return right === undefined ? left : left.filter((area) => right.includes(area));
};

// The fence a service's run is born inside, from its steward's and its profile's.
const areasOf = (steward: readonly string[] | undefined, profile: AccessProfile | undefined): { readonly areas?: readonly string[] } => {
    const areas = narrower(steward, profile?.areas);
    return areas === undefined ? {} : { areas };
};

const WHERE = "on Sandbox ▸ Access ▸ Programs";

/** Whether the service named can run now, and the fence its run is born inside. */
export const serviceStanding = async (deps: ServiceStandingDeps, id: string): Promise<ServiceStanding> => {
    const service = await deps.services.get(id);
    if (service === undefined) {
        return { ok: false, reason: `It runs as the service "${id}", which this sandbox no longer has: point it at another service, or write that one again ${WHERE}.` };
    }
    const name = service.label ?? service.id;
    const [owner, roster, profile] = await Promise.all([
        deps.ownerEmail(),
        deps.members.list(),
        service.profile === undefined ? undefined : deps.accessProfiles.get(service.profile),
    ]);
    if (service.profile !== undefined && profile === undefined) {
        return { ok: false, reason: `It runs as the service "${name}", whose access profile "${service.profile}" no longer exists: give the service another ${WHERE}.` };
    }
    const steward = lower(service.steward);
    if (owner !== undefined && lower(owner) === steward) {
        return { ok: true, service, ...areasOf(undefined, profile) };
    }
    const member = roster.find((row) => lower(row.email) === steward);
    if (member === undefined) {
        return { ok: false, reason: `It runs as the service "${name}", which acts for ${steward}, who no longer has access to this sandbox: give it a new steward ${WHERE}.` };
    }
    const access = memberAccess(member);
    if (!access.manage && access.agents !== "run") {
        return { ok: false, reason: `It runs as the service "${name}", which acts for ${steward}, who does not run agents here: give it a steward who does ${WHERE}.` };
    }
    return { ok: true, service, ...areasOf(access.see, profile) };
};
