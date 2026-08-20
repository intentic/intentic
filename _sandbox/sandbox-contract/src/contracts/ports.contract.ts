import { oc } from "@orpc/contract";
import { OkSchema, PortForwardResultSchema, PortParamSchema, PortsListSchema } from "../schemas.js";

// Listening TCP ports in the sandbox + explicit forwarding through the preview proxy (see the ports section in
// schemas.ts). `forward` is idempotent, re-forwarding a port returns its existing slot's URL; `unforward`
// frees the slot immediately (the hostname keeps resolving, the proxy just stops mapping it).
export const portsContract = {
    list: oc.route({ method: "GET", path: "/ports" }).output(PortsListSchema),
    forward: oc.route({ method: "POST", path: "/ports/forward" }).input(PortParamSchema).output(PortForwardResultSchema),
    unforward: oc.route({ method: "POST", path: "/ports/unforward" }).input(PortParamSchema).output(OkSchema),
};
