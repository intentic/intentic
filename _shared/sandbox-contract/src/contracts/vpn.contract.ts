import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events/system-events.js";
import { OkSchema } from "../schemas/shared.js";
import { ForticlientImportInputSchema, ForticlientImportSchema, VpnConnectInputSchema, VpnIdParamSchema, VpnListSchema } from "../schemas/vpn.js";

// A VPN is added as a `vpn` capability; connecting and dropping it happen through the routes here, called by both the
// operator UI and the agent's `vpn` CLI.
// Every route reads tunnel state from the OS, not daemon memory, so a shell-dropped tunnel and a UI-dropped one are the
// same event across a restart.
export const vpnContract = {
    // Every configured VPN with its live link state; feeds the VPN card, rail indicator, and `vpn list`.
    list: oc
        .route({
            method: "GET",
            path: "/vpn",
            summary: "Configured tunnels and which are up",
            description:
                "Every stored VPN with its live link state, read back from the operating system rather than from memory, so a tunnel dropped from a shell and one dropped from a screen look the same here.",
        })
        .output(VpnListSchema),
    // Dials a stored VPN, streaming auth and routing progress; idempotent, an already-up tunnel is just reported.
    connect: oc
        .route({
            method: "POST",
            path: "/vpn/{id}/connect",
            summary: "Dial a VPN",
            description:
                "Brings a stored tunnel up, streaming the client's progress as it authenticates and then sets up routing. Streamed because a dial takes seconds and can fail with something you have to read: a wrong password, a gateway certificate nobody trusts, a code it wants. Connecting one that is already up simply says so.",
        })
        .input(VpnConnectInputSchema)
        .output(eventIterator(IntenticLineSchema)),
    // Drops a tunnel; tolerates one already down, since the contract is "not up," not "it was up."
    disconnect: oc
        .route({
            method: "POST",
            path: "/vpn/{id}/disconnect",
            summary: "Drop a tunnel",
            description: "Takes the tunnel down. One that was already down is fine: the promise is that it is not up afterwards.",
        })
        .input(VpnIdParamSchema)
        .output(OkSchema),
    // Parses an exported FortiClient config into addable connections a user can pick instead of retyping.
    importForticlient: oc
        .route({
            method: "POST",
            path: "/vpn/import-forticlient",
            summary: "Read connections out of an exported config",
            description:
                "Turns an exported FortiClient configuration into a list of connections you can add, so somebody holding that file picks from a list instead of retyping a host and port for every tunnel.",
        })
        .input(ForticlientImportInputSchema)
        .output(ForticlientImportSchema),
};
