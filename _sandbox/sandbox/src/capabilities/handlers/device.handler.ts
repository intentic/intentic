import type { DeviceConfig } from "@intentic/sandbox-contract";
import { HOST_TOOLS_NOTE } from "../../hosts/host-skills.js";
import { peerHandler } from "./peer.handler.js";

/* A device of the user's OWN, one capability per machine, the id being its name: the peer handler (peers/) over the host door. */
export const deviceHandler = peerHandler<DeviceConfig>({
    kind: "device",
    noun: "device",
    where: "on that device",
    note: HOST_TOOLS_NOTE,
    pairHint: "click Connect and run the one-liner on that device",
    awayHint: "the device is offline",
    added: (id) => `Added "${id}". Run the one-time command its entry is offering on that device, the agent can work on it from the next turn.`,
    store: (ctx) => ctx.hosts,
    hub: (ctx) => ctx.hostHub,
    // One card holds every OS install on the machine; the enrollment store knows which (each record names its card),
    // so removing or renaming the card takes all of them in one write.
    echo: (host) => ({
        platform: host.platform,
        shell: host.shell,
        write: host.write,
        screen: host.screen,
        control: host.control,
        sandboxes: host.sandboxes,
        destructive: host.destructive,
        ...(host.roots !== undefined ? { roots: host.roots } : {}),
    }),
});
