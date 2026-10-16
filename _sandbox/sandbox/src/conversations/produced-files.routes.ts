import { defineRawRoutes } from "../http/raw-route-server.js";
import type { Services } from "../composition.js";
import { createProducedFileRoute } from "./produced-files.js";

// A conversation's recorded documents as bytes; off oRPC since the body is streamed bytes.
export const producedFileRawRoutes = defineRawRoutes((services: Pick<Services, "agents" | "transcripts" | "workspaceScope">) => ({
    "GET /agents/{id}/documents/raw": createProducedFileRoute(services),
}));
