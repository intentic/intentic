import type { HostConfig } from "@intentic/sandbox-contract";
import { HOST_TOOLS_NOTE } from "../../hosts/host-skills.js";
import { peerHandler } from "./peer.handler.js";

/* A device of the user's OWN, one capability per machine, the id being its name: the peer handler (peers/) over
 * the host door. Distinct from `ssh`, where the sandbox does the dialling and there is nothing to install on
 * the far end. The OS pack is data in an installed extension's `contributes.capabilities`; the tool surface it
 * wraps (host-skills.ts), the enrollment and the scope enforcement are core. */
export const hostHandler = peerHandler<HostConfig>({
    kind: "host",
    noun: "device",
    where: "on that device",
    note: HOST_TOOLS_NOTE,
    pairHint: "click Connect and run the one-liner on that device",
    awayHint: "the device is offline",
    added: (id) => `Added "${id}". Run the one-time command its card is offering on that device, the agent can work on it from the next turn.`,
    store: (ctx) => ctx.hosts,
    hub: (ctx) => ctx.hostHub,
    echo: (host) => ({
        platform: host.platform,
        shell: host.shell,
        write: host.write,
        screen: host.screen,
        control: host.control,
        sandboxes: host.sandboxes,
        sandboxRemove: host.sandboxRemove,
        destructive: host.destructive,
        ...(host.roots !== undefined ? { roots: host.roots } : {}),
    }),
});
