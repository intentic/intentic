import type { SharedIdentity } from "@intentic/sandbox-contract/schemas/devices";
import { isDerivedMachineId } from "@intentic/sandbox-contract/schemas/hosts";
import type { Services } from "../composition.js";

// Revoke superseded enrollments only after a newer connection proves the same agent-reported machine id and environment.
// Derived placeholder ids prove nothing. Use append order to remove only older entries; never revoke one connected now.
// Simultaneous live identities may be clones or alternate addresses, so keep both and expose sharedIdentities instead.

type Enrolled = { readonly id: string; readonly card: string; readonly machineId: string; readonly environment: string };
type Online = (id: string) => boolean;

// One machine environment's enrollments, oldest first, keyed by the identity they report. Derived ids sit out.
const byIdentity = (enrolled: readonly Enrolled[]): Map<string, Enrolled[]> => {
    const groups = new Map<string, Enrolled[]>();
    for (const entry of enrolled) {
        if (isDerivedMachineId(entry.machineId)) {
            continue;
        }
        const key = `${entry.machineId} ${entry.environment}`;
        groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return groups;
};

export interface Superseded {
    readonly stale: Enrolled;
    // The enrollment that made it dead: the one that just connected, or at boot the newest of its machine environment.
    readonly by: Enrolled;
}

// What to revoke. With `keeper`, only that connection's own machine environment, judged against it (on connect);
// without, every machine environment, judged against its newest enrollment (at boot, when nothing holds a socket yet).
export const supersededEnrollments = (enrolled: readonly Enrolled[], online: Online, keeper?: string): Superseded[] =>
    [...byIdentity(enrolled).values()].flatMap((group) => {
        const at = keeper === undefined ? group.length - 1 : group.findIndex((entry) => entry.id === keeper);
        const by = group[at];
        if (by === undefined) {
            return [];
        }
        return group.slice(0, at).flatMap((stale) => (online(stale.id) ? [] : [{ stale, by }]));
    });

// Two or more connections live at once under one identity: what the Devices screen warns about, since this sandbox
// cannot tell those computers apart and so never dedupes them.
export const sharedIdentities = (enrolled: readonly Enrolled[], online: Online): SharedIdentity[] =>
    [...byIdentity(enrolled).values()].flatMap((group) => {
        const live = group.filter((entry) => online(entry.id));
        const first = live[0];
        return first === undefined || live.length < 2
            ? []
            : [{ machineId: first.machineId, connections: live.map(({ id, card, environment }) => ({ id, card, environment })) }];
    });

// Revokes what `supersededEnrollments` names, asking the hub again right before each one, since a socket may have
// arrived while the list was read. Answers the connection keys it revoked.
export const revokeSuperseded = async (services: Pick<Services, "hosts" | "hostHub" | "logger">, keeper?: string): Promise<string[]> => {
    const online: Online = (id) => services.hostHub.online(id);
    const revoked: string[] = [];
    for (const { stale, by } of supersededEnrollments(await services.hosts.list(), online, keeper)) {
        if (online(stale.id) || !(await services.hosts.revoke(stale.id))) {
            continue;
        }
        revoked.push(stale.id);
        services.logger.info(
            { revoked: stale.id, card: stale.card, supersededBy: by.id, machineId: stale.machineId, environment: stale.environment },
            "hosts: revoked an older key of a computer that has since connected with a newer one",
        );
    }
    return revoked;
};

// The live-identity clashes as the device list carries them; a list that cannot be read is no clash, not a failure.
export const liveSharedIdentities = async (services: Pick<Services, "hosts" | "hostHub">): Promise<SharedIdentity[]> => {
    const connected = services.hostHub.connected();
    if (connected.length < 2) {
        return [];
    }
    const live = new Set(connected);
    return sharedIdentities(await services.hosts.list(), (id) => live.has(id));
};
