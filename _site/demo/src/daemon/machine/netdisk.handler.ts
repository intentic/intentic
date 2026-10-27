import { dropLink, mountNetdisk, netdiskLinks } from "./liveLinks";
import type { Doors } from "../doors";

// The sandbox's network disks, one per disk connection on the Capabilities page (daemon/liveLinks.ts): mounted with
// progress streamed, and unmounted.
export const netdiskDoors = {
    list: () => ({ links: netdiskLinks() }),
    mount: ({ id }) => mountNetdisk(id),
    unmount: ({ id }) => dropLink(`netdisk`, id),
} satisfies Doors<`netdisk`>;
