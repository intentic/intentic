import type { SharedIdentity } from "@intentic/sandbox-contract/schemas/devices";
import { isDerivedMachineId } from "@intentic/sandbox-contract/schemas/hosts";
import type { Services } from "../composition.js";

// (2026-10-18) ONE COMPUTER'S ONE OS INSTALL HOLDS ONE KEY INTO THIS SANDBOX, so an older key of the same install is
// dead weight. The machine agent keeps one link per sandbox address (upsertLink in _devices/machine), and a pairing
// replaces it there; so once a newer enrollment of the same machine id and environment has connected, every enrollment
// made before it was overwritten on that computer and can never be presented again. Revoking it takes nothing away.
// It only stays behind as a credential nobody holds: under a card renamed outside the rename path, it is the
// "leftover connection" the Devices screen lists.
//
// Three guards keep this from cutting a real machine off:
// - Only ids an agent said count. A derived id (`card:<name>`) is a placeholder from before the agent reported one,
//   and proves nothing about which computer it is.
// - Only enrollments made BEFORE the connection that supersedes them. The store appends each pairing (enrollment.ts
//   `issue`), so its list is oldest first; an older key presenting itself while a newer one exists is not the overwrite
//   above, and is left alone.
// - Never one that is connected right now. Two live connections claiming one identity are two computers sharing an id
//   (a cloned VM, a copied home folder), or one agent reaching this sandbox at two addresses: either way both are in
//   use, so both are kept and the Devices screen says so (`sharedIdentities`).

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
