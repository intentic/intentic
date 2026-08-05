import type { SecretRef } from "@intentic/graph";
import { generated, httpOk, makeRef } from "@intentic/graph";
import type { HostInput, ServiceIntent, ServiceKind } from "@intentic/need-resolver";
import type { ResolvedNode, ResourceType } from "@intentic/resources";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// The service catalog: each authorable `kind` maps to the concrete resource type its provider deploys and
// the dashboard port that provider publishes on the host (tunnel-routed to <domain>). Adding a service is
// one entry here plus a provider — the authoring surface (i.want.service) is unchanged. The OTLP ingest
// port a service exposes for app telemetry is the signoz provider's concern, not the resolver's — apps
// reach it through the service's `otlpEndpoint` output, not a routed hostname.
interface ServiceSpec {
    readonly type: ResourceType;
    readonly port: number;
    // The pinned images this service's provider deploys, by input key. Carried here so adding a service is
    // one catalog entry (type + port + its images), and so the versions land in the desired-state graph.
    readonly images: Readonly<Record<string, string>>;
    // How this kind is reached as an MCP tool from the sandbox agent, when a workspace exposes it via
    // `i.want.workspace({ tools: [...] })`: the path on the service's routed domain that speaks MCP, and the
    // intentic-generated secret key holding the scoped bearer token. Absent ⇒ the kind has no agent tool.
    readonly mcp?: { readonly path: string; readonly tokenSecret: string };
    // Dashboard login when it is NOT the intentic@<zone> email convention (e.g. OpenProject's fixed "admin").
    readonly adminLogin?: string;
    // A second public hostname (a first-level `<sub>-auth.<zone>` sibling of the service) routed to this host
    // port, for services whose login flow needs a browser-reachable identity provider (Outline's bundled Dex).
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

// The MCP endpoint descriptor for a service kind, or undefined when the kind exposes no agent tool. The
// workspace resolver uses it to wire a tool's URL + scoped token into the sandbox (for the agent).
export const serviceMcp = (kind: ServiceKind): { readonly path: string; readonly tokenSecret: string } | undefined => catalog[kind].mcp;

// The admin identity intentic seeds for a service's dashboard. Services authenticate by email (unlike the
// Forgejo/Komodo username), so it is an address in the exposed zone; the password is intentic-generated.
const serviceAdminEmail = (zone: string): string => `intentic@${zone}`;

// A shared off-the-shelf service: one node deployed onto the host over SSH (like the platform's Forgejo /
// Komodo) from a pinned image, plus its Cloudflare route. The deploy node carries the host SSH creds + its
// internal ip and gates on its host-internal url so readiness passes before the tunnel + DNS route exist.
// Returns the exposure's ingress pair so the caller can aggregate the host's tunnel ingress.
export const resolveService = (
    intent: ServiceIntent,
    host: HostInput,
    zone: string,
    apiToken: SecretRef,
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const spec = catalog[intent.kind];
    const ssh = sshOf(host);
    const exposure = exposeRoute(intent.expose, intent.on, intent.domain, spec.port, apiToken);
    // A bundled identity provider (Outline's Dex) must be browser-reachable, so it gets its own hostname. It
    // stays ONE label under the zone (a `<sub>-auth.<zone>` sibling of the service, not an `auth.<domain>`
    // child) so Cloudflare's Universal SSL `*.<zone>` edge cert covers it — a child of a subdomain would be
    // two labels deep and have no cert, failing the TLS handshake. On the apex it is just `auth.<zone>`.
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
