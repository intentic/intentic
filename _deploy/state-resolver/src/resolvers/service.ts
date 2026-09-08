import type { SecretRef } from "@intentic/graph";
import { generated, httpOk, makeRef } from "@intentic/graph";
import type { HostInput, ServiceIntent, ServiceKind } from "@intentic/need-resolver";
import type { ResolvedNode, ResourceType } from "@intentic/resources";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// Service catalog: each `kind` maps to its resource type and dashboard port (tunnel-routed to <domain>). Adding a
// service is one entry plus a provider; OTLP ingest is the signoz provider's concern, reached via
// `otlpEndpoint`, not a routed hostname.
interface ServiceSpec {
    readonly type: ResourceType;
    readonly port: number;
    // Pinned images this service's provider deploys, by input key; keeps a service to one catalog entry.
    readonly images: Readonly<Record<string, string>>;
    // MCP path on the service's domain + secret key holding its scoped bearer token; absent means no agent tool.
    readonly mcp?: { readonly path: string; readonly tokenSecret: string };
    // Dashboard login when it isn't the intentic@<zone> email convention (e.g. OpenProject's "admin").
    readonly adminLogin?: string;
    // Second hostname (`<sub>-auth.<zone>` sibling) routed here, for a login IdP needing browser access (Dex).
    readonly authPort?: number;
    // readyWhen timeout override for slow first boots (OpenProject runs migrations before answering).
    readonly readyTimeout?: string;
}

const catalog: Readonly<Record<ServiceKind, ServiceSpec>> = {
    signoz: {
        type: "signoz",
        port: 8080,
        images: {
            clickhouseImage: IMAGES.clickhouse,
            signozImage: IMAGES.signoz,
            otelImage: IMAGES.signozOtelCollector,
            zookeeperImage: IMAGES.signozZookeeper,
        },
        mcp: { path: "/mcp", tokenSecret: "SIGNOZ_MCP_TOKEN" },
    },
    outline: {
        type: "outline",
        // 3000 is Forgejo's host port; Outline publishes its dashboard on 3210, its Dex on 5556.
        port: 3210,
        authPort: 5556,
        images: {
            outlineImage: IMAGES.outline,
            postgresImage: IMAGES.postgres,
            valkeyImage: IMAGES.valkey,
            dexImage: IMAGES.dex,
        },
    },
    paperless: {
        type: "paperless",
        port: 8000,
        images: { paperlessImage: IMAGES.paperless, valkeyImage: IMAGES.valkey },
    },
    openproject: {
        type: "openproject",
        port: 8082,
        adminLogin: "admin",
        readyTimeout: "600s",
        images: { openprojectImage: IMAGES.openproject },
    },
    invoiceninja: {
        type: "invoiceninja",
        // 8000/8080/8082 are taken (paperless/signoz/openproject); Invoice Ninja publishes on 8083.
        port: 8083,
        // First boot runs the full Laravel migration + seed before /health answers.
        readyTimeout: "600s",
        images: { invoiceninjaImage: IMAGES.invoiceninja, mariadbImage: IMAGES.mariadb, valkeyImage: IMAGES.valkey },
    },
    infisical: {
        type: "infisical",
        port: 8084,
        images: { infisicalImage: IMAGES.infisical, postgresImage: IMAGES.postgres, valkeyImage: IMAGES.valkey },
    },
};

// MCP endpoint descriptor for a kind, or undefined if it has no agent tool; the workspace resolver wires it
// into the sandbox.
export const serviceMcp = (kind: ServiceKind): { readonly path: string; readonly tokenSecret: string } | undefined => catalog[kind].mcp;

// Admin identity for a service's dashboard; services authenticate by email, unlike Forgejo/Komodo's username.
const serviceAdminEmail = (zone: string): string => `intentic@${zone}`;

// Shared off-the-shelf service: one node deployed onto the host over SSH from a pinned image, plus its Cloudflare
// route; readiness gates on the host-internal url so it passes before the tunnel/DNS exist. Returns the exposure's
// ingress pair to aggregate.
export const resolveService = (
    intent: ServiceIntent,
    host: HostInput,
    zone: string,
    apiToken: SecretRef,
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const spec = catalog[intent.kind];
    const ssh = sshOf(host);
    const exposure = exposeRoute(intent.expose, intent.on, intent.domain, spec.port, apiToken);
    // Auth hostname stays one label under the zone (not nested under the service domain) so `*.<zone>` covers it.
    const authDomain =
        spec.authPort === undefined
            ? undefined
            : intent.domain === zone
              ? `auth.${zone}`
              : `${intent.domain.slice(0, -(zone.length + 1))}-auth.${zone}`;
    const authExposure =
        spec.authPort === undefined || authDomain === undefined
            ? undefined
            : exposeRoute(intent.expose, intent.on, authDomain, spec.authPort, apiToken);
    const nodes: ResolvedNode[] = [
        {
            id: intent.id,
            type: spec.type,
            inputs: {
                server: makeRef(intent.on),
                ...ssh,
                internalIp: makeRef<string>(intent.on, "internalIp"),
                domain: intent.domain,
                ...(authDomain === undefined ? {} : { authDomain }),
                adminUser: spec.adminLogin ?? serviceAdminEmail(zone),
                adminPassword: generated(`${intent.kind.toUpperCase()}_ADMIN_PASSWORD`),
                ...spec.images,
            },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(intent.id, "internalUrl"), { timeout: spec.readyTimeout ?? "180s" }),
        },
        exposure.route,
        ...(authExposure === undefined ? [] : [authExposure.route]),
    ];
    return { nodes, ingress: [exposure.ingress, ...(authExposure === undefined ? [] : [authExposure.ingress])] };
};
