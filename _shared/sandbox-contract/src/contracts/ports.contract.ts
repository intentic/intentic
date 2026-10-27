import { procedure } from "../protocol/route-meta.js";
import {
    PortForwardResultSchema,
    PortParamSchema,
    PortsListSchema,
    PreviewGuardSchema,
    PreviewPassRequestSchema,
    PreviewPassSchema,
} from "../schemas/ports.js";
import { OkSchema } from "../schemas/shared.js";

// Listening TCP ports in the sandbox + explicit forwarding through the preview proxy (see the ports section in
// schemas/ports.ts). `forward` is idempotent, re-forwarding a port returns its existing slot's URL; `unforward`
// frees the slot immediately (the hostname keeps resolving, the proxy just stops mapping it).
export const portsContract = {
    list: procedure
        .route({
            method: "GET",
            path: "/ports",
            summary: "What is listening inside the sandbox",
            description: "Every port something is answering on, and whether each one is reachable from outside.",
        })
        // The desktop-sync watcher's poll, and the machine's check-in.
        .meta({ sync: "poll" })
        .output(PortsListSchema),
    forward: procedure
        .route({
            method: "POST",
            path: "/ports/forward",
            summary: "Make a port reachable",
            description:
                "Gives one port an address on the outside. Asking twice is harmless: the second call hands back the address the first one made.",
        })
        .input(PortParamSchema)
        .output(PortForwardResultSchema),
    unforward: procedure
        .route({
            method: "POST",
            path: "/ports/unforward",
            summary: "Stop exposing a port",
            description: "Frees the slot at once. The address keeps resolving; it simply stops leading anywhere.",
        })
        .input(PortParamSchema)
        .output(OkSchema),
    // The owner's guard on previews (schemas/ports.ts): any member reads it, since the editor asks for a pass only where
    // it is on; only the owner changes it, like the passkey policy.
    previewGuard: procedure
        .route({
            method: "GET",
            path: "/previews/guard",
            summary: "Who may open this sandbox's previews",
            description: "Whether a panel's preview, and a forwarded port, ask a visitor to be one of this sandbox's members. The outbox is public whatever this says.",
        })
        .output(PreviewGuardSchema),
    setPreviewGuard: procedure
        .route({
            method: "POST",
            path: "/previews/guard",
            summary: "Choose who may open this sandbox's previews",
            description:
                "Opens previews to anyone with their address, or keeps them to this sandbox's members: panel previews alone, or forwarded ports too. Takes effect on the next request; a member's browser is signed in to a preview the first time they open it from the editor.",
        })
        .meta({ floor: "owner", panel: false, control: "never" })
        .input(PreviewGuardSchema)
        .output(PreviewGuardSchema),
    // A browser credential, so never the panel token's nor a control token's to mint, and not a guest's: a guest reaches
    // its assistants, not the workspace's apps.
    previewPass: procedure
        .route({
            method: "POST",
            path: "/previews/pass",
            summary: "Open a guarded preview in this browser",
            description:
                "Answers the address to send this browser to: through a one-time link, good for a minute, that leaves this browser holding the preview's pass for a week, or unchanged when nothing guards it.",
        })
        .meta({ floor: "viewer", panel: false, control: "never" })
        .input(PreviewPassRequestSchema)
        .output(PreviewPassSchema),
};
