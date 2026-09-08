import { DAEMON_PORT, PREVIEW_PORT } from "@intentic/constants";
import type { SecretRef } from "@intentic/graph";
import { generated, httpOk, makeRef } from "@intentic/graph";
import type { HostInput, ServiceKind, WorkspaceIntent } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { previewDomain } from "../lib/ids.js";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";
import { serviceMcp } from "./service.js";

// Provisioned service a workspace exposes as an agent tool: id (MCP server name), kind (to look up the endpoint
// path), and routed domain (URL base).
export interface WorkspaceTool {
    readonly id: string;
    readonly kind: ServiceKind;
    readonly domain: string;
}

// Shared internal docker network the sandbox attaches to.
const NETWORK = "intentic-workspace";

// Per-host AI-agent workspace: one sandbox container deployed over SSH from the pinned image, plus its wildcard
// `*.<zone>` route to its preview proxy. Readiness gates on the daemon's host-internal /health. Returns the
// exposure's ingress pair to aggregate onto the host's tunnel.
export const resolveWorkspace = (
    intent: WorkspaceIntent,
    host: HostInput,
    zone: string,
    apiToken: SecretRef,
    tools: readonly WorkspaceTool[],
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const ssh = sshOf(host);
    const domain = previewDomain(zone);
    const exposure = exposeRoute(intent.expose, intent.on, domain, PREVIEW_PORT, apiToken);
    // Each service becomes an MCP endpoint at its domain; its bearer secret key is shared with the tool itself.
    const toolEntries = tools.map((tool) => {
        const mcp = serviceMcp(tool.kind);
        if (mcp === undefined) {
            throw new Error(
                `workspace "${intent.id}" exposes service "${tool.id}" (kind "${tool.kind}") which has no MCP endpoint; only tool-capable services can be wired`,
            );
        }
        return { name: tool.id, url: `https://${tool.domain}${mcp.path}`, token: generated(mcp.tokenSecret) };
    });
    const nodes: ResolvedNode[] = [
        {
            id: intent.id,
            type: "workspace",
            inputs: {
                server: makeRef(intent.on),
                ...ssh,
                internalIp: makeRef<string>(intent.on, "internalIp"),
                domain,
                zone,
                previewPort: PREVIEW_PORT,
                daemonPort: DAEMON_PORT,
                network: NETWORK,
                image: IMAGES.sandbox,
                // The sandbox reads this as ANTHROPIC_BASE_URL for the agent; omitted ⇒ Anthropic's cloud.
                ...(intent.agentBaseUrl !== undefined ? { agentBaseUrl: intent.agentBaseUrl } : {}),
                // The agent's MCP tools (intent-declared internal services); omitted when none are exposed.
                ...(toolEntries.length > 0 ? { tools: toolEntries } : {}),
                // Approved overlay Dockerfile; provider builds+runs it instead of `image`, git-reviewed via
                // desired-state.json.
                ...(intent.dockerfile !== undefined ? { dockerfile: intent.dockerfile } : {}),
            },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(intent.id, "healthUrl"), { timeout: "120s" }),
        },
        exposure.route,
    ];
    return { nodes, ingress: [exposure.ingress] };
};
