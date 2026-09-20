import { oc } from "@orpc/contract";
import { streamOf } from "../protocol/routes.js";
import { IntenticLineSchema } from "../events/system-events.js";
import { NetdiskIdParamSchema, NetdiskListSchema } from "../schemas/netdisk.js";
import { OkSchema } from "../schemas/shared.js";

// A network disk is added as a `netdisk` capability; mounting and unmounting it happen through the routes here, called
// by both the operator UI and the agent's `netdisk` CLI.
// Every route reads mount state from the kernel, not daemon memory, so a disk unmounted from a shell and one unmounted
// from a screen are the same event across a restart.
export const netdiskContract = {
    list: oc
        .route({
            method: "GET",
            path: "/netdisk",
            summary: "Configured disks and which are mounted",
            description:
                "Every stored network disk with its live mount state, read back from the kernel's mount table rather than from memory, so a disk unmounted from a shell and one unmounted from a screen look the same here.",
        })
        .output(NetdiskListSchema),
    // Streamed: a mount can take seconds against a slow server and can fail with something a person has to read (a
    // refused password, an unreachable server behind a tunnel that is down).
    mount: oc
        .route({
            method: "POST",
            path: "/netdisk/{id}/mount",
            summary: "Mount a disk",
            description:
                "Mounts a stored disk at its place under /mnt/netdisk, streaming progress. Mounting one that is already mounted simply says so. A read-only disk is mounted read-only; the kernel refuses writes to it.",
        })
        .input(NetdiskIdParamSchema)
        .output(streamOf(IntenticLineSchema)),
    unmount: oc
        .route({
            method: "POST",
            path: "/netdisk/{id}/unmount",
            summary: "Unmount a disk",
            description: "Takes the disk down. One that was already unmounted is fine: the promise is that it is not mounted afterwards.",
        })
        .input(NetdiskIdParamSchema)
        .output(OkSchema),
};
