import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceTunnel } from "@intentic/sandbox-contract/schemas/device-artifacts";
import type { TunnelReach } from "../hosts/device-tunnels.js";
import { type NetdiskRelay, openRelay, relayTunnel, releaseRelay, SMB_PORT } from "./netdisk-relay.js";

// A disk reached through a computer: its tunnel is written down with the port the kernel mounted, reopened on that same
// port (standing when the kernel already holds the mount), shared by two disks on one server, and closed with the last.

interface Opened {
    readonly device: string;
    readonly localPort: number;
    readonly reach: TunnelReach | undefined;
}

const fakeRelay = (): NetdiskRelay & { readonly opened: Opened[]; readonly closed: string[] } => {
    const open = new Map<string, DeviceTunnel>();
    const opened: Opened[] = [];
    const closed: string[] = [];
    let next = 40_000;
    return {
        opened,
        closed,
        open: async (device, devicePort, localPort = devicePort, reach = {}) => {
            opened.push({ device, localPort, reach });
            const key = `${device}|${reach.host ?? ""}|${devicePort}`;
            const known = open.get(key);
            if (known !== undefined) {
                return known;
            }
            const port = localPort === 0 ? (next += 1) : localPort;
            const tunnel: DeviceTunnel = { device, host: reach.host, devicePort, localPort: port, url: `http://127.0.0.1:${port}`, openedAt: "x" };
            open.set(key, tunnel);
            return tunnel;
        },
        close: async (device, devicePort, host) => {
            closed.push(`${device}|${host ?? ""}|${devicePort}`);
            return open.delete(`${device}|${host ?? ""}|${devicePort}`);
        },
        list: () => [...open.values()],
        whenOnline: async () => true,
    };
};

beforeEach(() => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "netdisk-relay-"));
});

test("a disk's tunnel takes any free port, is written down, and is found open", async () => {
    const relay = fakeRelay();
    const port = await openRelay("team", { device: "rog", host: "files.corp" }, relay, false);
    expect(relay.opened).toEqual([{ device: "rog", localPort: 0, reach: { host: "files.corp", standing: false } }]);
    const record = JSON.parse(readFileSync(join(process.env["HOME"] ?? "", ".intentic-netdisk", "team.relay"), "utf8"));
    expect(record).toEqual({ device: "rog", host: "files.corp", port: SMB_PORT, localPort: port });
    expect(await relayTunnel("team", relay)).toEqual({ open: true, failure: undefined });
});

test("a daemon that restarted under a live mount reopens the tunnel on the port the kernel mounted, standing", async () => {
    const before = fakeRelay();
    const port = await openRelay("team", { device: "rog", host: "files.corp" }, before, false);
    const after = fakeRelay();
    expect(await relayTunnel("team", after)).toEqual({ open: false, failure: undefined });
    expect(await openRelay("team", { device: "rog", host: "files.corp" }, after, true)).toBe(port);
    expect(after.opened).toEqual([{ device: "rog", localPort: port, reach: { host: "files.corp", standing: true } }]);
});

test("a card that now names another computer does not reuse the old one's port", async () => {
    const relay = fakeRelay();
    await openRelay("team", { device: "rog", host: "files.corp" }, relay, false);
    await openRelay("team", { device: "omen", host: "files.corp" }, relay, false);
    expect(relay.opened.map((each) => each.localPort)).toEqual([0, 0]);
});

test("two disks on one server through one computer share a tunnel, which closes with the last of them", async () => {
    const relay = fakeRelay();
    const first = await openRelay("team", { device: "rog", host: "files.corp" }, relay, false);
    const second = await openRelay("archive", { device: "rog", host: "files.corp" }, relay, false);
    expect(second).toBe(first);
    await releaseRelay("team", relay);
    expect(relay.closed).toEqual([]);
    await releaseRelay("archive", relay);
    expect(relay.closed).toEqual([`rog|files.corp|${SMB_PORT}`]);
    // A disk that never went through one has nothing to let go of.
    await releaseRelay("direct", relay);
    expect(relay.closed).toHaveLength(1);
});
