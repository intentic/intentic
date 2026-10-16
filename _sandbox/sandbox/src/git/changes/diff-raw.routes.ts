import { defineRawRoutes } from "../../http/raw-route-server.js";
import type { Services } from "../../composition.js";
import { createDiffRawRoute } from "./diff-raw.js";

// Same bytes as one side of a diff instead of a tree file; off oRPC since the body is streamed binary.
export const diffRawRoutes = defineRawRoutes((services: Services) => ({ "GET /diff/raw": createDiffRawRoute(services) }));
