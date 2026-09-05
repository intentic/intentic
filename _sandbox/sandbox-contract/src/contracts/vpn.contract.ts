import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events.js";
import { OkSchema } from "../schemas/shared.js";
import { ForticlientImportInputSchema, ForticlientImportSchema, VpnConnectInputSchema, VpnIdParamSchema, VpnListSchema } from "../schemas/vpn.js";

// The live VPN surface. A VPN is ADDED as a `vpn` capability (credentials, autoConnect, capabilities.contract);
// it is DIALLED here. The split is deliberate: connecting is a runtime operation that both the operator (the
// VPN capability card) and the agent (`vpn` on its PATH, which calls these very routes) perform many times
// over one stored connection, so it cannot be a capability re-add, and its result is richer than a
// CapabilityStatus, which is why `list` returns VpnLinks instead of {state, detail}.
//
// Every route reads tunnel state back from the OS rather than from daemon memory, so the agent dropping a
// tunnel from a shell and the UI dropping it are the same event, and a daemon restart observes the truth.
export const vpnContract = {
    // Every configured VPN with its live link state, the VPN card, the rail indicator, and `vpn list`.
    list: oc
        .route({
            method: "GET",
            path: "/vpn",
            summary: "Configured tunnels and which are up",
            description:
                "Every stored VPN with its live link state, read back from the operating system rather than from memory, so a tunnel dropped from a shell and one dropped from a screen look the same here.",
        })
        .output(VpnListSchema),
    // Dial a stored VPN. Streams the client's progress (auth, then routing) because a dial takes seconds and
    // can fail with something the user must read, a wrong password, an untrusted gateway certificate, or a
    // required 2FA code. Idempotent: connecting an already-up tunnel reports it and stops.
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
    // Drop a tunnel. Tolerates an already-down one, "make it not be up" is the contract, not "it was up".
    disconnect: oc
        .route({
            method: "POST",
            path: "/vpn/{id}/disconnect",
            summary: "Drop a tunnel",
            description: "Takes the tunnel down. One that was already down is fine: the promise is that it is not up afterwards.",
        })
        .input(VpnIdParamSchema)
        .output(OkSchema),
    // Parse an exported FortiClient configuration into addable connections, so a user with that file fills the
    // add form by picking a connection instead of re-keying host/port/protocol per tunnel.
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
