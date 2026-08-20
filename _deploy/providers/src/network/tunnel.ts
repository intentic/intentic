import { pollUntil, type Provider, type ProviderContext, type ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { connectWithRetry, sshExecutor } from "../core/ssh.js";
import type { CloudflareApi, IngressRule } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";

const tunnelSchema = sshSchema.extend({
    name: z.string(),
    accountId: z.string(),
    apiToken: z.string(),
    ingress: z.array(z.object({ hostname: z.string(), port: z.coerce.number() })),
    // The pinned cloudflared image. The connector is stateless, so a version bump just recreates it.
    image: z.string(),
});
type TunnelInputs = z.infer<typeof tunnelSchema>;
const parse = (inputs: ResolvedInputs): TunnelInputs => parseInputs(tunnelSchema, inputs, "tunnel");

// Cloudflare requires every ingress list to end with a catch-all rule (no hostname). The provider owns
// this policy so the API adapter stays a dumb transport.
const CATCH_ALL: IngressRule = { service: "http_status:404" };

// Each public hostname routes to a co-located service on loopback at its fixed port. The connector runs
// --network host on the same host as every service it fronts, so 127.0.0.1 always reaches their published
// ports, and unlike the host's LAN ip, loopback works even where a container netns cannot reach that ip
// (e.g. WSL2 published-port hairpin). cloudflared matches rules top-down, first-match-wins, so wildcard
// hostnames (the preview `*.<zone>`, which overlaps every explicit host on the zone) must sink to the end,
// after all explicit rules and before the catch-all 404. toSorted is stable, so order within each group
// is preserved.
const desiredRules = (parsed: TunnelInputs): IngressRule[] => [
    ...parsed.ingress
        .toSorted((a, b) => Number(a.hostname.startsWith("*")) - Number(b.hostname.startsWith("*")))
        .map((rule) => ({ hostname: rule.hostname, service: `http://127.0.0.1:${rule.port}` })),
    CATCH_ALL,
];

const cname = (tunnelId: string): string => `${tunnelId}.cfargotunnel.com`;
const containerName = (tunnelId: string): string => `intentic-tunnel-${tunnelId}`;

const ingressEqual = (a: readonly IngressRule[], b: readonly IngressRule[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((rule, index) => {
        const other = b[index];
        return other !== undefined && rule.hostname === other.hostname && rule.service === other.service;
    });
};

// Is the cloudflared connector running on the host, and on which image? A read-only SSH check; a host that
// is not reachable is reported as not-running (and logged) so a plan proceeds rather than aborting, apply
// will surface the connection failure as a hard error. The image lets diff recreate on a version bump.
const checkConnector = async (
    executor: SshExecutor,
    parsed: TunnelInputs,
    tunnelId: string,
    ctx: ProviderContext,
): Promise<{ running: boolean; image: string | undefined }> => {
    let session: SshSession;
    try {
        session = await executor.connect(sshTarget(parsed));
    } catch (error) {
        ctx.log(`tunnel "${ctx.id}": host not reachable over SSH to check the connector: ${String(error)}`);
        return { running: false, image: undefined };
    }
    try {
        const name = containerName(tunnelId);
        const result = await session.exec(`docker ps --filter "name=^${name}$" --format '{{.Names}}'`);
        if (result.stdout.trim() !== name) {
            return { running: false, image: undefined };
        }
        const image = (await session.exec(`docker inspect --format '{{.Config.Image}}' ${name} 2>/dev/null || true`)).stdout.trim();
        return { running: true, image };
    } finally {
        await session.dispose();
    }
};

// A freshly-run connector registers with the edge asynchronously; until it does, every public hostname on
// the host answers Cloudflare error 1033, including control-plane urls a later node in the SAME apply may
// dial. Poll the tunnel's edge-side status so apply returns only once the tunnel actually serves.
const CONNECT_TIMEOUT_MS = 120_000;
const CONNECT_INTERVAL_MS = 3_000;
const waitConnected = async (api: CloudflareApi, parsed: TunnelInputs, tunnelId: string, log: (message: string) => void): Promise<void> => {
    // The last status seen, so the give-up message names what the edge was actually reporting rather than
    // "not healthy".
    let status = "unknown";
    const connected = await pollUntil(
        async () => {
            status = await api.getTunnelStatus({ accountId: parsed.accountId, apiToken: parsed.apiToken, tunnelId });
            return status === "healthy" || status === "degraded";
        },
        {
            timeoutMs: CONNECT_TIMEOUT_MS,
            intervalMs: CONNECT_INTERVAL_MS,
            onRetry: () => log(`tunnel "${parsed.name}": waiting for the connector to register with Cloudflare (status "${status}")…`),
        },
    );
    if (!connected) {
        throw new Error(`cloudflared connector did not register with Cloudflare within ${CONNECT_TIMEOUT_MS}ms (tunnel status "${status}")`);
    }
};

// (Re)start the cloudflared connector on the host. Idempotent: remove any prior container, then run a
// fresh one, the connector is stateless (its ingress lives in Cloudflare). --network host lets it dial
// the services' internal urls. Waits out a booting host's tunnel warm-up, then propagates the connection
// failure as the hard error for a host that never comes up.
const runConnector = async (
    executor: SshExecutor,
    parsed: TunnelInputs,
    tunnelId: string,
    token: string,
    log: (message: string) => void,
): Promise<void> => {
    const session = await connectWithRetry(executor, sshTarget(parsed), { log });
    try {
        const name = containerName(tunnelId);
        await session.exec(`docker rm -f ${name} 2>/dev/null || true`);
        const run = await session.exec(
            `docker run -d --restart unless-stopped --network host --name ${name} ${parsed.image} tunnel --no-autoupdate run --token ${token}`,
        );
        if (run.code !== 0) {
            throw new Error(`failed to start cloudflared on host: exited ${run.code}: ${run.stderr.trim()}`);
        }
    } finally {
        await session.dispose();
    }
};

// The Cloudflare Tunnel for one host: a remotely-managed cfd_tunnel whose connector (cloudflared) runs on
// the host and whose ingress maps the host's public hostnames to their internal service urls. read finds
// the tunnel and surfaces the actual ingress + connector state via detail so the pure diff can detect
// drift; apply ensures the tunnel exists, the connector runs, and the ingress matches.
export const createTunnelProvider = (api: CloudflareApi = cloudflareApi, executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently),
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "accountId")) {
            return undefined;
        }
        const parsed = parse(inputs);
        const tunnel = await api.findTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name });
        if (tunnel === undefined) {
            return undefined;
        }
        const ingress = await api.getTunnelIngress({ accountId: parsed.accountId, apiToken: parsed.apiToken, tunnelId: tunnel.id });
        const connector = await checkConnector(executor, parsed, tunnel.id, ctx);
        return {
            outputs: { tunnelId: tunnel.id, cname: cname(tunnel.id) },
            detail: { ingress: ingress ?? [], connectorRunning: connector.running, image: connector.image },
        };
    },
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const detail = observed.detail;
        if (detail === undefined || detail["connectorRunning"] !== true) {
            return { action: "update", reason: "cloudflared connector is not running on the host" };
        }
        if (detail["image"] !== parsed.image) {
            return { action: "update", reason: `cloudflared image differs (running ${String(detail["image"])}, want ${parsed.image})` };
        }
        const current = detail["ingress"];
        const actual = Array.isArray(current) ? (current as IngressRule[]) : [];
        if (!ingressEqual(actual, desiredRules(parsed))) {
            return { action: "update", reason: "tunnel ingress differs from desired" };
        }
        return { action: "noop" };
    },
    apply: async (inputs, observed, ctx) => {
        const parsed = parse(inputs);
        const existing = await api.findTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name });
        const tunnel = existing ?? (await api.createTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name }));
        // Set the ingress in Cloudflare BEFORE any connector (re)start: a remotely-managed cloudflared
        // fetches its config on startup and receives later edits as live pushes from the edge.
        await api.putTunnelIngress({
            accountId: parsed.accountId,
            apiToken: parsed.apiToken,
            tunnelId: tunnel.id,
            ingress: desiredRules(parsed),
        });
        // A running connector on the desired image needs no restart, the ingress PUT above reaches it as a
        // live config push, with zero downtime. Restarting here would blackhole every public hostname on the
        // host (Cloudflare 1033) for the re-registration window, including control-plane urls later nodes in
        // this same apply dial. Restart only when the connector is missing or its image drifted, and then
        // wait until the edge reports the tunnel serving before letting dependents proceed.
        const detail = observed?.detail;
        const connectorCurrent = detail?.["connectorRunning"] === true && detail["image"] === parsed.image;
        if (!connectorCurrent) {
            const token = await api.getTunnelToken({ accountId: parsed.accountId, apiToken: parsed.apiToken, tunnelId: tunnel.id });
            await runConnector(executor, parsed, tunnel.id, token, ctx.log);
            await waitConnected(api, parsed, tunnel.id, ctx.log);
        }
        return { tunnelId: tunnel.id, cname: cname(tunnel.id) };
    },
    delete: async (inputs) => {
        const parsed = parse(inputs);
        const tunnel = await api.findTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, name: parsed.name });
        if (tunnel === undefined) {
            return;
        }
        // Remove the host connector first, then delete the (now-disconnected) tunnel in Cloudflare.
        const session = await executor.connect(sshTarget(parsed));
        try {
            await session.exec(`docker rm -f ${containerName(tunnel.id)} 2>/dev/null || true`);
        } finally {
            await session.dispose();
        }
        await api.deleteTunnel({ accountId: parsed.accountId, apiToken: parsed.apiToken, tunnelId: tunnel.id });
    },
});
