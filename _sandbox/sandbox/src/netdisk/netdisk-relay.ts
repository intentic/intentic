import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import type { DeviceTunnels } from "../hosts/device-tunnels.js";
import { netdiskDir, relayPath } from "./netdisk-paths.js";

/* A DISK REACHED THROUGH ONE OF THE OWNER'S COMPUTERS (2026-11-10, the card's `via`). The sandbox's packets leave
through Docker's NAT and its names resolve on public DNS, so a share the owner's PC opens through its own VPN client, or
by a name only the PC's resolvers know (a VPN's DNS suffix, a NetBIOS or .local name, its hosts file), times out or does
not resolve from here. Through `via`, the computer's agent dials the server itself: a `devices reach` tunnel to the
server's SMB port, listening on the sandbox's loopback, and the kernel mounts `//server/share` with `ip=127.0.0.1` and
the tunnel's port, so the server still sees its own name in the tree connect.

The tunnel's sandbox port is written down beside the disk for as long as the kernel can hold the mount (the container's
life, like the rest of ~/.intentic-netdisk): the kernel reconnects to the address it mounted, so a daemon that restarts
under a live mount reopens the tunnel on that same port, standing, before the computer has reconnected. Two disks on
one server through one computer share one tunnel, which closes with the last of them. */

export const SMB_PORT = 445;

// What a disk asks of the daemon's device tunnels.
export type NetdiskRelay = Pick<DeviceTunnels, "open" | "close" | "list" | "whenOnline">;

const RelayRecordSchema = z.object({ device: z.string(), host: z.string(), port: z.int(), localPort: z.int() });
type RelayRecord = z.infer<typeof RelayRecordSchema>;

const readRecord = async (path: string): Promise<RelayRecord | undefined> => {
    const text = await readFile(path, "utf8").catch(undefinedIfMissing);
    return text === undefined ? undefined : parseJsonWith(text, RelayRecordSchema);
};

const sameTunnel = (a: RelayRecord, b: Pick<RelayRecord, "device" | "host" | "port">): boolean => a.device === b.device && a.host === b.host && a.port === b.port;

// Every other disk's record: who else still rides a tunnel this disk lets go of.
const otherRecords = async (id: string): Promise<RelayRecord[]> => {
    const names = (await readdir(netdiskDir()).catch(undefinedIfMissing)) ?? [];
    const records = await Promise.all(
        names.filter((name) => name.endsWith(".relay") && name !== `${id}.relay`).map((name) => readRecord(join(netdiskDir(), name))),
    );
    return records.filter((record) => record !== undefined);
};

// Opens (or finds) the tunnel a disk mounts through and writes it down; answers the sandbox port to mount at. `standing`:
// the kernel already holds the mount, so the tunnel listens even while the computer is away, on the port it mounted.
export const openRelay = async (id: string, through: { readonly device: string; readonly host: string }, relay: NetdiskRelay, standing: boolean): Promise<number> => {
    const wanted = { device: through.device, host: through.host, port: SMB_PORT };
    const remembered = await readRecord(relayPath(id));
    const localPort = remembered !== undefined && sameTunnel(remembered, wanted) ? remembered.localPort : 0;
    const tunnel = await relay.open(wanted.device, SMB_PORT, localPort, { host: wanted.host, standing });
    await mkdir(netdiskDir(), { recursive: true, mode: 0o700 });
    await writeFile(relayPath(id), JSON.stringify({ ...wanted, localPort: tunnel.localPort } satisfies RelayRecord), { mode: 0o600 });
    return tunnel.localPort;
};

// Lets a disk's tunnel go: its record always, the tunnel only when no other disk still mounts through it. Nothing to do
// for a disk that never went through one, whatever its card says now.
export const releaseRelay = async (id: string, relay: NetdiskRelay): Promise<void> => {
    const record = await readRecord(relayPath(id));
    await rm(relayPath(id), { force: true });
    if (record === undefined || (await otherRecords(id)).some((other) => sameTunnel(other, record))) {
        return;
    }
    await relay.close(record.device, record.port, record.host);
};

// The tunnel a disk mounts through, while it is open: its port, and what the computer last said when it could not dial.
export const relayTunnel = async (id: string, relay: NetdiskRelay): Promise<{ readonly open: boolean; readonly failure?: string | undefined }> => {
    const record = await readRecord(relayPath(id));
    const tunnel = record === undefined ? undefined : relay.list().find((each) => each.device === record.device && each.host === record.host && each.devicePort === record.port);
    return { open: tunnel !== undefined && tunnel.localPort === record?.localPort, failure: tunnel?.failure };
};
