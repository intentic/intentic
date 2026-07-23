import { createHash } from "node:crypto";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { connectWithRetry, sshExecutor } from "../core/ssh.js";

// One agent MCP tool, resolved: a remote endpoint reached by URL with a scoped bearer. The engine resolves
// the token secret before this provider runs, so `token` is the concrete string here.
const toolSchema = z.object({ name: z.string(), url: z.string(), token: z.string() });

const workspaceSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    zone: z.string(),
    previewPort: z.coerce.number(),
    daemonPort: z.coerce.number(),
    network: z.string(),
    image: z.string(),
    // Anthropic-compatible base URL the sandbox reads as ANTHROPIC_BASE_URL for the agent; absent ⇒ cloud.
    agentBaseUrl: z.string().optional(),
    // The agent's MCP tools (intent-declared internal services), forwarded into the sandbox as the agent's
    // remote MCP servers. Absent ⇒ no tools.
    tools: z.array(toolSchema).optional(),
    // Owner-approved overlay Dockerfile content (FROM the official sandbox image). When set, apply builds it
    // on the host and runs the sandbox from the result instead of `image`. Absent ⇒ the stock image.
    dockerfile: z.string().optional(),
});
type WorkspaceInputs = z.infer<typeof workspaceSchema>;
const parse = (inputs: ResolvedInputs): WorkspaceInputs => parseInputs(workspaceSchema, inputs, "workspace");

// One sandbox per host (like the platform's Forgejo/Komodo) — a fixed name + workspace volume, matching the
// connect.sh local flow so the two bootstraps stay in lockstep. DOCKER_VOLUME backs the in-sandbox Docker
// Engine's /var/lib/docker (images + dev-DB volumes survive recreates; layers land on a real filesystem).
const CONTAINER = "intentic-sandbox-workspace";
const WORKSPACE_VOLUME = "intentic-workspace-workspace";
const DOCKER_VOLUME = "intentic-docker-workspace";

// A stable digest of the resolved tools, stamped as a container label so a tools change (not just an image
// bump) triggers a recreate. Empty when no tools are wired.
const toolsDigest = (tools: WorkspaceInputs["tools"]): string =>
    tools === undefined || tools.length === 0 ? "" : createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);

// The full sha256 of the overlay content — the daemon reads it back as SANDBOX_ENVIRONMENT_HASH and compares
// it against sha256 of the approved file, so it MUST match the daemon's hash of the same string.
const environmentDigest = (dockerfile: string): string => createHash("sha256").update(dockerfile).digest("hex");

// The image the sandbox should run: the overlay's digest is baked into the tag, so the existing image diff
// drives recreate-on-overlay-change with no extra label (and a custom-image container never reads as drift
// against the stock tag).
const desiredImage = (parsed: WorkspaceInputs): string =>
    parsed.dockerfile === undefined ? parsed.image : `intentic-sandbox-env:${environmentDigest(parsed.dockerfile).slice(0, 12)}`;

const RUNTIME_ALLOWLIST = new Set(["--device=/dev/net/tun", "--cap-add=NET_ADMIN", "--privileged"]);
const RUNTIME_DIRECTIVE = "# intentic:runtime ";

// Container privileges come ONLY from "# intentic:runtime" directive lines in the owner-approved overlay —
// emitted by capability fragments (the vpn's WireGuard needs tun + NET_ADMIN; the docker capability's nested
// engine needs --privileged) — allowlisted hard so an overlay can't smuggle arbitrary docker flags. The base
// run is unprivileged. "" when no overlay or no directives; a trailing space otherwise, so it splices into the
// run command cleanly.
const runtimeFlags = (dockerfile: string | undefined): string => {
    if (dockerfile === undefined) {
        return "";
    }
    const flags = new Set<string>();
    for (const line of dockerfile.split("\n")) {
        if (!line.startsWith(RUNTIME_DIRECTIVE)) {
            continue;
        }
        for (const token of line.slice(RUNTIME_DIRECTIVE.length).trim().split(/\s+/)) {
            if (!RUNTIME_ALLOWLIST.has(token)) {
                throw new Error(`unsupported runtime directive in the workspace overlay: ${token}`);
            }
            flags.add(token);
        }
    }
    return flags.size === 0 ? "" : `${[...flags].join(" ")} `;
};

const internalUrl = (parsed: WorkspaceInputs): string => `http://${parsed.internalIp}:${parsed.daemonPort}`;
const outputsFor = (parsed: WorkspaceInputs): Record<string, unknown> => ({
    internalUrl: internalUrl(parsed),
    healthUrl: `${internalUrl(parsed)}/health`,
    previewBase: parsed.zone,
});

const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}'`);
    return result.stdout.trim() === CONTAINER;
};

const runningImage = async (session: SshSession): Promise<string> => {
    const result = await session.exec(`docker inspect --format '{{.Config.Image}}' ${CONTAINER} 2>/dev/null || true`);
    return result.stdout.trim();
};

// The tools digest stamped on the running container (empty when the label is absent).
const runningToolsDigest = async (session: SshSession): Promise<string> => {
    const result = await session.exec(`docker inspect --format '{{index .Config.Labels "intentic.tools"}}' ${CONTAINER} 2>/dev/null || true`);
    return result.stdout.trim();
};

// The per-host AI-agent workspace: one long-lived SANDBOX container (the workspace IS the sandbox now — no
// runner, no HOST docker socket; it carries its own isolated Docker Engine). Its preview proxy listens on
// `previewPort`, which the host's wildcard `*.<zone>` tunnel route points at; the daemon on `daemonPort` is
// host-internal (preview-only — connect.sh is the browser-direct path). read returns the resource only when
// the container runs the desired image; apply is idempotent — it ensures the shared network exists, then
// (re)creates the sandbox privileged with the workspace + docker volumes and both ports bound to the host's
// internal ip (so only the tunnel reaches them).
export const createWorkspaceProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently) —
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "internalIp")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`workspace "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session))) {
                return undefined;
            }
            // Two independent `|| true`'d inspects — concurrent, one round-trip instead of two.
            const [image, tools] = await Promise.all([runningImage(session), runningToolsDigest(session)]);
            return { outputs: outputsFor(parsed), detail: { image, tools } };
        } finally {
            await session.dispose();
        }
    },
    // Recreate on a sandbox-image bump or an agent-tools change (the container is stateless aside from the
    // workspace volume, which persists across recreations).
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const image = desiredImage(parsed);
        if (observed.detail?.["image"] !== image) {
            return {
                action: "update",
                reason: `workspace sandbox image differs (running ${String(observed.detail?.["image"])}, want ${image})`,
            };
        }
        const wantTools = toolsDigest(parsed.tools);
        if (observed.detail?.["tools"] !== wantTools) {
            return {
                action: "update",
                reason: `workspace agent tools changed (running ${String(observed.detail?.["tools"])}, want ${wantTools})`,
            };
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        // Validate the overlay's runtime directives up front — a bad overlay must not even build.
        const runtime = runtimeFlags(parsed.dockerfile);
        // Wait out a booting host's tunnel warm-up rather than hard-failing the recreate on the first dial error.
        const session = await connectWithRetry(executor, sshTarget(parsed), { log: ctx.log });
        try {
            const image = desiredImage(parsed);
            let environmentEnv = ``;
            if (parsed.dockerfile !== undefined) {
                // Build BEFORE the container is touched, so a failed build leaves the old sandbox running.
                // The content rides base64-encoded through the SSH command (the INTENTIC_AGENT_TOOLS
                // precedent) into a stdin build — an overlay is FROM + RUN/ENV only, no build context.
                const build = await session.exec(
                    `printf '%s' ${Buffer.from(parsed.dockerfile).toString("base64")} | base64 -d | docker build -t ${image} -`,
                );
                if (build.code !== 0) {
                    throw new Error(`failed to build the workspace overlay image on host: exited ${build.code}: ${build.stderr.trim()}`);
                }
                environmentEnv = ` -e SANDBOX_ENVIRONMENT_HASH=${environmentDigest(parsed.dockerfile)}`;
            }
            await session.exec(`docker network inspect ${parsed.network} >/dev/null 2>&1 || docker network create ${parsed.network}`);
            // Forwarded into the sandbox so the agent talks to a custom Anthropic endpoint.
            const agentEnv = parsed.agentBaseUrl !== undefined ? ` -e ANTHROPIC_BASE_URL=${parsed.agentBaseUrl}` : ``;
            // The agent's MCP tools, base64-encoded so the JSON (quotes/braces) rides the docker `-e` cleanly
            // through the SSH command. The daemon decodes + connects them for each agent turn.
            const digest = toolsDigest(parsed.tools);
            const toolsEnv =
                parsed.tools !== undefined && parsed.tools.length > 0
                    ? ` -e INTENTIC_AGENT_TOOLS=${Buffer.from(JSON.stringify(parsed.tools)).toString("base64")}`
                    : ``;
            const run = await session.exec(
                // rm + run in ONE exec: when `intentic apply` runs INSIDE the sandbox being recreated, the rm
                // kills the CLI — two separate execs would never reach the run.
                // Unprivileged by default — container privileges (the docker capability's --privileged for its
                // ISOLATED nested engine, the vpn's tun + NET_ADMIN) ride in solely through the overlay's
                // allowlisted runtime directives (runtimeFlags above), like rebuild.sh's local path. The host's
                // docker socket is never mounted.
                // Both ports bind the host's INTERNAL ip — cloudflared
                // (--network host) reaches the preview proxy there for the wildcard preview route, and the engine
                // health-probes the daemon, without exposing either on the host's public interface. The tools
                // digest label drives recreate-on-change. SANDBOX_NAME/SANDBOX_IMAGE feed the daemon's /info.
                // The rm destroys the old container's `docker logs` — keep its tail on the host first, so a
                // failed recreate still has the predecessor's record (fetchable via `intentic logs`). The
                // json-file caps stop an unbounded log from filling the host disk.
                // --dns: `intentic apply` runs `cloudflared access tcp` in here to reach enrolled hosts by their
                // freshly-minted ssh-<id>.<zone> tunnel name; a public resolver (Cloudflare, where the zone lives)
                // avoids the operator resolver's negatively-cached NXDOMAIN that otherwise fails the dial (ECONNRESET).
                `(docker logs --tail 2000 ${CONTAINER} > /opt/intentic/workspace-previous.log 2>&1 || true) && ` +
                    `(docker rm -f ${CONTAINER} 2>/dev/null || true) && ` +
                    `docker run -d --restart unless-stopped --name ${CONTAINER} --label intentic.id=${ctx.id} --label intentic.type=workspace --label intentic.tools=${digest} ` +
                    `--network ${parsed.network} --add-host host.docker.internal:host-gateway --dns 1.1.1.1 --dns 1.0.0.1 ` +
                    `--log-opt max-size=10m --log-opt max-file=3 ` +
                    runtime +
                    `-p ${parsed.internalIp}:${parsed.previewPort}:${parsed.previewPort} -p ${parsed.internalIp}:${parsed.daemonPort}:${parsed.daemonPort} ` +
                    `-v ${WORKSPACE_VOLUME}:/work -v ${DOCKER_VOLUME}:/var/lib/docker ` +
                    `-e WORKSPACE_ROOT=/work -e SANDBOX_HOST=0.0.0.0 -e SANDBOX_PORT=${parsed.daemonPort} ` +
                    `-e PREVIEW_PORT=${parsed.previewPort} ` +
                    `-e SANDBOX_NAME=${CONTAINER} -e SANDBOX_IMAGE=${image}${environmentEnv}${agentEnv}${toolsEnv} ${image}`,
            );
            if (run.code !== 0) {
                throw new Error(`failed to start workspace sandbox on host: exited ${run.code}: ${run.stderr.trim()}`);
            }
            return outputsFor(parsed);
        } finally {
            await session.dispose();
        }
    },
    // Parses only the SSH block, so it works from a removed node's inputs AND a ListedResource's (a host's).
    delete: async (inputs) => {
        const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, "workspace")));
        try {
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
        } finally {
            await session.dispose();
        }
    },
    list: (sources, ctx) => listStampedContainers(executor, "workspace", sources, ctx.log),
});
