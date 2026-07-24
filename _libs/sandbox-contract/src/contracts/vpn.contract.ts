import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events.js";
import {
    ForticlientImportInputSchema,
    ForticlientImportSchema,
    OkSchema,
    VpnConnectInputSchema,
    VpnIdParamSchema,
    VpnListSchema,
} from "../schemas.js";

// The live VPN surface. A VPN is ADDED as a `vpn` capability (credentials, autoConnect — capabilities.contract);
// it is DIALLED here. The split is deliberate: connecting is a runtime operation that both the operator (the
// Sandbox ▸ Status card) and the agent (`vpn` on its PATH, which calls these very routes) perform many times
// over one stored connection, so it cannot be a capability re-add — and its result is richer than a
// CapabilityStatus, which is why `list` returns VpnLinks instead of {state, detail}.
//
// Every route reads tunnel state back from the OS rather than from daemon memory, so the agent dropping a
// tunnel from a shell and the UI dropping it are the same event, and a daemon restart observes the truth.
export const vpnContract = {
    // Every configured VPN with its live link state — the Status card, the rail indicator, and `vpn list`.
    list: oc.route({ method: "GET", path: "/vpn" }).output(VpnListSchema),
    // Dial a stored VPN. Streams the client's progress (auth, then routing) because a dial takes seconds and
    // can fail with something the user must read — a wrong password, an untrusted gateway certificate, or a
    // required 2FA code. Idempotent: connecting an already-up tunnel reports it and stops.
    connect: oc.route({ method: "POST", path: "/vpn/{id}/connect" }).input(VpnConnectInputSchema).output(eventIterator(IntenticLineSchema)),
    // Drop a tunnel. Tolerates an already-down one — "make it not be up" is the contract, not "it was up".
    disconnect: oc.route({ method: "POST", path: "/vpn/{id}/disconnect" }).input(VpnIdParamSchema).output(OkSchema),
    // Parse an exported FortiClient configuration into addable connections, so a user with that file fills the
    // add form by picking a connection instead of re-keying host/port/protocol per tunnel.
    importForticlient: oc.route({ method: "POST", path: "/vpn/import-forticlient" }).input(ForticlientImportInputSchema).output(ForticlientImportSchema),
};
