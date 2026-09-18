import type { Capability } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { InvariantCheck } from "../invariants/invariants.js";
import { isReadOnly, type MountEntry, readMountinfo } from "./mountinfo.js";
import { MOUNT_ROOT, mountPoint } from "./netdisk-paths.js";

// The one promise the access switch makes, un-checked after the mount: a disk added as read-only stays read-only. The
// container holds CAP_SYS_ADMIN, so `mount -o remount,rw` is one command away for anything running in it; the flag is
// read back from the kernel and a disagreement is reported, since nothing else would notice.
// Second, the inverse: nothing is mounted under the disks' root that the manifest never asked for.

export const owner = "netdisk";

export interface NetdiskInvariantDeps {
    readonly capabilities: CapabilitiesStore;
    // The kernel's mount table; injected so the check is testable without a share.
    readonly mounts?: () => Promise<readonly MountEntry[]>;
}

const disksOf = (capabilities: readonly Capability[]) =>
    capabilities.flatMap((capability) => (capability.kind === "netdisk" ? [{ id: capability.id, access: capability.config.access }] : []));

export const checks = ({ capabilities, mounts = readMountinfo }: NetdiskInvariantDeps): readonly InvariantCheck[] => [
    {
        name: "a-read-only-disk-is-mounted-read-only",
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            const disks = disksOf(await capabilities.list());
            if (disks.length === 0) {
                return;
            }
            const table = await mounts();
            const drifted = disks.filter((disk) => {
                const entry = table.findLast((candidate) => candidate.mountPoint === mountPoint(disk.id));
                return disk.access === "read" && entry !== undefined && entry.fsType === "cifs" && !isReadOnly(entry);
            });
            if (drifted.length > 0) {
                fail(
                    `expected every read-only disk to be mounted read-only, found ${drifted
                        .map((disk) => `${mountPoint(disk.id)} (netdisk "${disk.id}")`)
                        .join(", ")} accepting writes. The card says read-only; something remounted it. Unmount and mount it again, and give the disk a read-only account on the server, the one fence nothing in this container can move.`,
                );
            }
        },
    },
    {
        name: "nothing-under-the-disk-root-but-the-manifest's-disks",
        on: ["boot", "sweep"],
        run: async ({ fail }) => {
            const known = new Set(disksOf(await capabilities.list()).map((disk) => mountPoint(disk.id)));
            const stray = (await mounts()).filter((entry) => entry.mountPoint.startsWith(`${MOUNT_ROOT}/`) && !known.has(entry.mountPoint));
            if (stray.length > 0) {
                fail(
                    `expected only the manifest's disks under ${MOUNT_ROOT}, found ${stray
                        .map((entry) => `${entry.mountPoint} (${entry.fsType} ${entry.source})`)
                        .join(", ")}. A mount there the card list does not name was made by hand; the daemon will not manage it and the user cannot see it.`,
                );
            }
        },
    },
];
