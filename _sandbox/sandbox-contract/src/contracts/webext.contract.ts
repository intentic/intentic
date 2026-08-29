import { oc } from "@orpc/contract";
import { z } from "zod";
import { OkSchema, WebExtFactsSchema, WebExtScopesSchema } from "../schemas.js";

/* What a connected BROWSER can be asked, over the socket its extension opened to this sandbox.
 *
 * The inversion is the host contract's (contracts/host.contract.ts): the extension dialled out, and the
 * extension is the oRPC SERVER. A browser cannot be dialled — it is behind the same NAT as the laptop it runs
 * on, and it is not even a process that is always there — so it can only be the side that connects, while
 * everything is asked OF it.
 *
 * `mcp` IS THE SAME DELIBERATE HOLE IN THE TYPING, for the same reason: if this contract described each tool,
 * a browser could not learn one without a matching daemon release, and the daemon would have to hold every
 * tool's schema to translate. Keeping one opaque procedure buys the extension the Chrome Web Store's release
 * cycle, which is measured in review days and is not this daemon's to wait on. The payload is still validated
 * where it is understood: in the extension, against the tool's own schema.
 *
 * There is no `runSandboxFlow` twin here. A browser runs nothing that takes minutes and narrates itself; every
 * one of its operations is a click or a read that either happened or did not. */
export const webextContract = {
    // What this browser is, and what it is currently allowed to touch: pulled right after the socket
    // authenticates and again whenever the card is read, because the grant list changes IN THE BROWSER (the
    // person clicks Allow on a site) rather than here, so a cached copy would be a card that lies.
    describe: oc.output(WebExtFactsSchema),
    /* The switches the owner ticked on the capability card. The extension ENFORCES them; nothing on this side
     * checks one. Note what is NOT in here: which sites the agent may touch. Those are Chrome's own optional
     * host permissions, granted by the person in the browser and revocable there, so the strongest boundary in
     * this feature is one the sandbox cannot even describe, let alone widen. */
    setScopes: oc.input(WebExtScopesSchema).output(OkSchema),
    // Liveness, driven by the daemon: doubles as the keepalive for the tunnel and as the probe whose failure
    // means the browser is closed rather than quiet.
    ping: oc.output(OkSchema),
    // One MCP JSON-RPC message in, its answer out, forwarded verbatim in both directions. See above.
    mcp: oc.input(z.unknown()).output(z.unknown()),
};
