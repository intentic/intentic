import { oc } from "@orpc/contract";
import { OkSchema, PortForwardResultSchema, PortParamSchema, PortsListSchema } from "../schemas.js";

// Listening TCP ports in the sandbox + explicit forwarding through the preview proxy (see the ports section in
// schemas.ts). `forward` is idempotent, re-forwarding a port returns its existing slot's URL; `unforward`
// frees the slot immediately (the hostname keeps resolving, the proxy just stops mapping it).
export const portsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/ports",
            summary: "What is listening inside the sandbox",
            description: "Every port something is answering on, and whether each one is reachable from outside.",
        })
        .output(PortsListSchema),
    forward: oc
        .route({
            method: "POST",
            path: "/ports/forward",
            summary: "Make a port reachable",
            description:
                "Gives one port an address on the outside. Asking twice is harmless: the second call hands back the address the first one made.",
        })
        .input(PortParamSchema)
        .output(PortForwardResultSchema),
    unforward: oc
        .route({
            method: "POST",
            path: "/ports/unforward",
            summary: "Stop exposing a port",
            description: "Frees the slot at once. The address keeps resolving; it simply stops leading anywhere.",
        })
        .input(PortParamSchema)
        .output(OkSchema),
};
