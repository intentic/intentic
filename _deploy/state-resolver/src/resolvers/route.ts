import type { SecretRef } from "@intentic/graph";
import { makeRef } from "@intentic/graph";
import type { ResolvedNode } from "@intentic/resources";
import { tunnelId } from "../lib/ids.js";

const slug = (hostname: string): string =>
    hostname
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

// The stable cf-route id for a hostname, so callers can both build the route and depend on it.
export const routeId = (cloudflareId: string, hostname: string): string => `${cloudflareId}-${slug(hostname)}`;

// One entry in a host tunnel's ingress: a public hostname routed to a service on the host's internal ip at
// a fixed port. The port (not a service ref) keeps the tunnel independent of the deployment nodes, so it
// can be brought up before the control plane that relies on its public routes.
export interface IngressPair {
    readonly hostname: string;
    readonly port: number;
}

// Exposing one public hostname through the host's Cloudflare Tunnel produces two things kept in sync: a
// proxied DNS CNAME (hostname -> the tunnel's cfargotunnel hostname), owned by the cf-route node, and an
// ingress rule (hostname -> host-internal port), aggregated onto the host's tunnel node.
export const exposeRoute = (
    cloudflareId: string,
    hostId: string,
    hostname: string,
    port: number,
    apiToken: SecretRef,
): { route: ResolvedNode; ingress: IngressPair } => ({
    route: {
        id: routeId(cloudflareId, hostname),
        type: "cf-route",
        inputs: { hostname, zoneId: makeRef(cloudflareId, "zoneId"), apiToken, cname: makeRef(tunnelId(hostId), "cname") },
        explicitDependsOn: [cloudflareId, tunnelId(hostId)],
    },
    ingress: { hostname, port },
});
