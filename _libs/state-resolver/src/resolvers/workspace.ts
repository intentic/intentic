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

// A provisioned service a workspace exposes to its agent as a tool, resolved to what the wiring needs: its
// id (the MCP server name), its kind (to look up the MCP endpoint path), and its routed domain (the URL base).
export interface WorkspaceTool {
    readonly id: string;
    readonly kind: ServiceKind;
    readonly domain: string;
}

// The sandbox's preview-proxy port (the app preview the host's wildcard `*.<zone>` tunnel ingress routes to,
// ordered last so it loses to every explicit host; apps declare their own ports behind it) and the daemon's
// HTTP port (host-internal
// only — the server workspace is preview-only; the browser-direct path is connect.sh, not this).
// The shared internal docker network the sandbox attaches to.
const NETWORK = "intentic-workspace";

// The per-host AI-agent workspace: one sandbox container deployed onto the host over SSH (like the platform's
// Forgejo/Komodo) from the pinned sandbox image, plus its WILDCARD `*.<zone>` Cloudflare route to the
// sandbox's own preview proxy. The node carries the host SSH creds + internal ip; it gates on the daemon's
// host-internal /health so readiness passes before the tunnel + DNS route exist. Returns the exposure's ingress
// pair so the caller aggregates it onto the host's tunnel — the sandbox is just another service on that tunnel.
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
    // Each exposed service becomes a remote MCP endpoint at its routed domain, with an intentic-generated
    // scoped bearer the sandbox forwards into the agent. The same secret key is what the tool itself
    // authenticates against, so client and server share it through the secret store.
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
                // The approved overlay Dockerfile content; the provider builds + runs it instead of `image`.
                // It lands in desired-state.json verbatim — the git review there IS the server-path approval.
                ...(intent.dockerfile !== undefined ? { dockerfile: intent.dockerfile } : {}),
            },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(intent.id, "healthUrl"), { timeout: "120s" }),
        },
        exposure.route,
    ];
    return { nodes, ingress: [exposure.ingress] };
};
