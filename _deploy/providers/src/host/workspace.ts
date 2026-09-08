import { createHash } from "node:crypto";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { OPTIONAL_DIRECTIVES, runtimeDirectivesOf, sandboxNames, sandboxRunCommand } from "@intentic/sandbox-run";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { connectWithRetry, sshExecutor } from "../core/ssh.js";

// One agent MCP tool, resolved: a remote endpoint reached by URL with a scoped bearer; `token` is already the
// concrete secret string by the time this provider runs.
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
    // Agent's MCP tools, forwarded into the sandbox as its remote MCP servers; absent means none.
    tools: z.array(toolSchema).optional(),
    // Owner-approved overlay Dockerfile; when set, apply builds and runs it instead of `image`.
    dockerfile: z.string().optional(),
});
type WorkspaceInputs = z.infer<typeof workspaceSchema>;
const parse = (inputs: ResolvedInputs): WorkspaceInputs => parseInputs(workspaceSchema, inputs, "workspace");

// One sandbox per host, named via the shared naming contract so it matches connect.sh.
const NAMES = sandboxNames("workspace");
const CONTAINER = NAMES.container;

// Stable digest of the resolved tools, stamped as a label so a tools change alone triggers recreate; empty when none.
const toolsDigest = (tools: WorkspaceInputs["tools"]): string =>
    tools === undefined || tools.length === 0 ? "" : createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);

// sha256 of the overlay content; must match the daemon's own hash of the same string (SANDBOX_ENVIRONMENT_HASH).
const environmentDigest = (dockerfile: string): string => createHash("sha256").update(dockerfile).digest("hex");

// Image the sandbox should run; the overlay's digest is baked into the tag, so the existing image-diff alone
// drives recreate-on-overlay-change, with no extra label.
const desiredImage = (parsed: WorkspaceInputs): string =>
    parsed.dockerfile === undefined ? parsed.image : `intentic-sandbox-env:${environmentDigest(parsed.dockerfile).slice(0, 12)}`;

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

// Per-host AI-agent workspace: one long-lived sandbox container with its own isolated Docker Engine. previewPort
// is the tunnel's target; daemonPort is host-internal only. `apply` ensures the network, then (re)creates the sandbox.
export const createWorkspaceProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A pending dependency means this resource cannot be introspected yet; parsing would crash on the symbol.
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
            // Two independent `|| true`'d inspects, concurrent, one round-trip instead of two.
            const [image, tools] = await Promise.all([runningImage(session), runningToolsDigest(session)]);
            return { outputs: outputsFor(parsed), detail: { image, tools } };
        } finally {
            await session.dispose();
        }
    },
    // Recreates on a sandbox-image bump or agent-tools change; only the workspace/history/docker volumes persist.
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
        // Validates overlay runtime directives up front; a bad overlay must not even build.
        const runtime = runtimeDirectivesOf(parsed.dockerfile ?? "");
        // Wait out a booting host's tunnel warm-up rather than hard-failing the recreate on the first dial error.
        const session = await connectWithRetry(executor, sshTarget(parsed), { log: ctx.log });
        try {
            const image = desiredImage(parsed);
            if (parsed.dockerfile !== undefined) {
                // Builds before touching the container, so a failed build leaves the old sandbox running.
                const build = await session.exec(
                    `printf '%s' ${Buffer.from(parsed.dockerfile).toString("base64")} | base64 -d | docker build -t ${image} -`,
                );
                if (build.code !== 0) {
                    throw new Error(`failed to build the workspace overlay image on host: exited ${build.code}: ${build.stderr.trim()}`);
                }
            }
            await session.exec(`docker network inspect ${parsed.network} >/dev/null 2>&1 || docker network create ${parsed.network}`);
            // Probes the host for each optional directive requested; a missing one degrades that feature, not the
            // apply.
            const unsupported: string[] = [];
            for (const directive of OPTIONAL_DIRECTIVES.filter((entry) => runtime.includes(entry.token))) {
                const runtimes = directive.probe.kind === "runtime" ? (await session.exec(`docker info --format '{{json .Runtimes}}'`)).stdout : "";
                const probe =
                    directive.probe.kind === "runtime"
                        ? runtimes.includes(`"${directive.probe.name}"`)
                        : (await session.exec(`test -e ${directive.probe.path}`)).code === 0;
                if (!probe) {
                    unsupported.push(directive.token);
                    ctx.log(`workspace "${ctx.id}": host cannot provide ${directive.token}, starting without ${directive.name}`);
                }
            }
            const digest = toolsDigest(parsed.tools);
            // Adds the network, internal-ip-only port binds and a workaround for cloudflared's cached NXDOMAIN on a
            // fresh
            // tunnel name; baseImage stops a pinned overlay from reading as permanently unbuilt once the daemon infers
            // a base.
            const runCommand = sandboxRunCommand({
                names: { ...NAMES, network: parsed.network },
                image,
                baseImage: parsed.image,
                ...(parsed.dockerfile !== undefined ? { environmentHash: environmentDigest(parsed.dockerfile) } : {}),
                runtime,
                unsupported,
                init: false,
                alias: false,
                ports: [
                    `${parsed.internalIp}:${parsed.previewPort}:${parsed.previewPort}`,
                    `${parsed.internalIp}:${parsed.daemonPort}:${parsed.daemonPort}`,
                ],
                labels: [`intentic.id=${ctx.id}`, `intentic.type=workspace`, `intentic.tools=${digest}`],
                dns: ["1.1.1.1", "1.0.0.1"],
                env: [
                    ["WORKSPACE_ROOT", WORKSPACE_ROOT],
                    ["SANDBOX_HOST", "0.0.0.0"],
                    ["SANDBOX_PORT", String(parsed.daemonPort)],
                    ["PREVIEW_PORT", String(parsed.previewPort)],
                    // Forwarded into the sandbox so the agent talks to a custom Anthropic endpoint.
                    ...(parsed.agentBaseUrl !== undefined ? [["ANTHROPIC_BASE_URL", parsed.agentBaseUrl] as const] : []),
                    // MCP tools, base64-encoded so the JSON rides docker `-e` through SSH; the daemon decodes them.
                    ...(parsed.tools !== undefined && parsed.tools.length > 0
                        ? [["INTENTIC_AGENT_TOOLS", Buffer.from(JSON.stringify(parsed.tools)).toString("base64")] as const]
                        : []),
                ],
            });
            const run = await session.exec(
                // rm + run in one exec: splitting them would kill the CLI when apply recreates its own sandbox
                // mid-command.
                // Logs are tailed to disk before rm, so a failed recreate still has the predecessor's record (`intentic
                // deploy logs`).
                `(docker logs --tail 2000 ${CONTAINER} > /opt/intentic/workspace-previous.log 2>&1 || true) && ` +
                    `(docker rm -f ${CONTAINER} 2>/dev/null || true) && ${runCommand}`,
            );
            if (run.code !== 0) {
                throw new Error(`failed to start workspace sandbox on host: exited ${run.code}: ${run.stderr.trim()}`);
            }
            return outputsFor(parsed);
        } finally {
            await session.dispose();
        }
    },
    // Parses only the SSH block, so it works from a removed node's inputs or a ListedResource's.
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
