import { DAEMON_PORT, PREVIEW_PORT } from "@intentic/constants";
import {
    CATCH_ALL,
    cfargotunnelCname,
    hostSshTunnelName,
    labelHostname,
    sandboxHostname as sandboxHost,
    sandboxSubdomain,
    sshHostname,
} from "@intentic/sandbox-contract";
import { hostSshIdFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";

// Request-scoped Cloudflare access for the setup screen's zone picker. The user's API token is used ONLY to
// list the zones it can see, then dropped with the request — it is never persisted, logged, or stored. The
// browser can't call Cloudflare directly (its API returns no CORS headers for a token'd request), so this
// minimal server-side proxy stands in. Deliberately standalone: the platform must not depend on the sandbox's
// @intentic/providers — the secret-free architecture keeps platform and sandbox code apart.

const BASE = "https://api.cloudflare.com/client/v4";

// Cloudflare rejected the token — invalid/inactive, or missing the Zone:Read scope. The router maps this to a
// user-facing BAD_REQUEST so the setup screen can tell the user to fix the token. Any other failure (network,
// unexpected response shape) propagates unchanged.
export class CloudflareTokenError extends Error {}

// A non-2xx Cloudflare response (other than the 401/403 token case, which is CloudflareTokenError). `codes` are
// the numeric error codes from the response envelope (e.g. 1022 = tunnel has active connections) so callers can
// branch on the code rather than the human message, which Cloudflare rewords. Extends Error so the existing
// `instanceof Error` → BAD_GATEWAY catchers keep mapping it.
export class CloudflareApiError extends Error {
    constructor(
        message: string,
        readonly codes: number[],
    ) {
        super(message);
    }
}

// `result` is left unknown so an error envelope (success:false, result:null) surfaces its `errors` rather than
// failing the result-shape check first — validated as a zone array only after the success check passes.
const envelopeSchema = z.object({
    success: z.boolean(),
    errors: z.array(z.object({ code: z.number(), message: z.string() })),
    result: z.unknown(),
    result_info: z.object({ total_pages: z.number() }).partial().optional(),
});
const zonesResultSchema = z.array(z.object({ name: z.string() }));

// Every zone name the token can see, paginated (50/page). A 401/403 becomes a CloudflareTokenError so the
// caller can present "fix your token" rather than a generic failure.
// The platform keeps a self-contained Cloudflare REST client (zone listing here + tunnel provisioning below)
// rather than importing @intentic/providers, so the thin platform API never pulls the engine's SSH/Docker deps.
// The one thing that MUST agree with the CLI/daemon — the tunnel-id digest — is shared via
// @intentic/sandbox-contract/tunnel-ids (imported above), so only Cloudflare's own stable GET /zones shape is
// duplicated, and only that needs keeping in step.
export const listZoneNames = async (token: string): Promise<string[]> => {
    const names: string[] = [];
    let page = 1;
    let totalPages = 1;
    do {
        // oxlint-disable-next-line eslint/no-await-in-loop -- pagination: totalPages is only known after fetching each page, so pages must be fetched sequentially
        const response = await fetch(`${BASE}/zones?per_page=50&page=${page}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 401 || response.status === 403) {
            throw new CloudflareTokenError("the Cloudflare API token is invalid or lacks the Zone:Read scope");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- reading this page's body before deciding whether a next page exists
        const envelope = envelopeSchema.parse(await response.json());
        if (!response.ok || !envelope.success) {
            const detail = envelope.errors.map((error) => `${error.code} ${error.message}`).join("; ");
            throw new Error(`Cloudflare GET /zones failed (HTTP ${response.status}): ${detail}`);
        }
        for (const zone of zonesResultSchema.parse(envelope.result)) {
            names.push(zone.name);
        }
        totalPages = envelope.result_info?.total_pages ?? 1;
        page += 1;
    } while (page <= totalPages);
    return names;
};

// Fetch + validate a Cloudflare success envelope, returning the parsed `result`. A 401/403 becomes a
// CloudflareTokenError (a misconfigured intentic token surfaces the same way an under-scoped user token does);
// any other transport/API failure propagates unchanged.
const cfCall = async <T>(token: string, path: string, resultSchema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        // A stalled Cloudflare API must reject (surfacing a 502 upstream) rather than hang the caller forever.
        signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
        throw new CloudflareTokenError("the intentic Cloudflare API token is invalid or lacks the required scope");
    }
    const envelope = envelopeSchema.parse(await response.json());
    if (!response.ok || !envelope.success) {
        const detail = envelope.errors.map((error) => `${error.code} ${error.message}`).join("; ");
        throw new CloudflareApiError(
            `Cloudflare ${init?.method ?? "GET"} ${path} failed (HTTP ${response.status}): ${detail}`,
            envelope.errors.map((error) => error.code),
        );
    }
    return resultSchema.parse(envelope.result);
};

// Upsert a proxied CNAME hostname → content, idempotently: update the existing record when one exists,
// create it otherwise. Shared by provisionTunnel and ensurePreviewRoute.
const upsertCname = async (apiToken: string, zoneId: string, hostname: string, content: string, comment: string): Promise<void> => {
    const records = await cfCall(
        apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
        z.array(z.object({ id: z.string() })),
    );
    const body = JSON.stringify({ type: "CNAME", name: hostname, content, proxied: true, comment });
    const recordId = records[0]?.id;
    if (recordId === undefined) {
        await cfCall(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records`, z.unknown(), { method: "POST", body });
        return;
    }
    await cfCall(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, z.unknown(), {
        method: "PUT",
        body,
    });
};

// Resolve an intentic-owned zone name to its zone id + owning account id (Cloudflare returns the account with
// each zone). Shared by provisionTunnel and the reaper — the account id is discovered here, never configured.
const resolveZone = async (apiToken: string, zone: string): Promise<{ zoneId: string; accountId: string }> => {
    const zones = await cfCall(
        apiToken,
        `/zones?name=${encodeURIComponent(zone)}`,
        z.array(z.object({ id: z.string(), account: z.object({ id: z.string() }) })),
    );
    const found = zones[0];
    if (found === undefined) {
        throw new Error(`the intentic Cloudflare zone "${zone}" was not found for the configured token`);
    }
    return { zoneId: found.id, accountId: found.account.id };
};

// Provision (idempotently) an intentic-owned remotely-managed tunnel + proxied DNS: find-or-create the tunnel
// by name, PUT its ingress (one rule per route), upsert a proxied CNAME per route, and return the connector
// token cloudflared runs with. Shared by the sandbox and host-SSH provisioners, which differ only in naming
// and routes.
const provisionTunnel = async (args: {
    apiToken: string;
    zone: string;
    name: string;
    routes: { hostname: string; service: string; comment: string }[];
}): Promise<string> => {
    const { apiToken, zone, name, routes } = args;
    const { zoneId, accountId } = await resolveZone(apiToken, zone);
    const existing = await cfCall(
        apiToken,
        `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
        z.array(z.object({ id: z.string() })),
    );
    const tunnelId =
        existing[0]?.id ??
        (
            await cfCall(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, z.object({ id: z.string() }), {
                method: "POST",
                body: JSON.stringify({ name, config_src: "cloudflare" }),
            })
        ).id;
    const tunnelToken = await cfCall(
        apiToken,
        `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
        z.string(),
    );
    const ingress = [...routes.map(({ hostname, service }) => ({ hostname, service })), CATCH_ALL];
    await cfCall(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, z.unknown(), {
        method: "PUT",
        body: JSON.stringify({ config: { ingress } }),
    });
    // Upsert the proxied CNAME hostname → <tunnelId>.cfargotunnel.com for every route.
    const content = cfargotunnelCname(tunnelId);
    for (const { hostname, comment } of routes) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of routes; sequenced to keep upserts simple
        await upsertCname(apiToken, zoneId, hostname, content, comment);
    }
    return tunnelToken;
};

// Provision the intentic-owned sandbox tunnel that exposes the sandbox daemon at `sandbox-<id>.<zone>` and the
// container's sshd at `ssh-<id>.<zone>` (the transport the local Mutagen sync uses). `<id>` is the same stable
// digest of the connection token the CLI + browser derive, so re-runs reuse the same tunnel/hostnames. Mirrors
// createSandboxTunnel in the sandbox CLI, but runs on the platform with intentic's token — reimplemented with
// direct REST here because the platform must not depend on @intentic/providers (see this file's header). No
// preview wildcard — on the SHARED intentic zone a single `*.<zone>` record can't be per-user; instead
// ensurePreviewRoute mints a concrete `preview-<panel>-<id>.<zone>` route lazily when a panel starts.
// Own-Cloudflare users get the wildcard on their own zone (createSandboxTunnel).
// The 12-char digest of the connect token that names a sandbox's intentic tunnel. Delegates to the SHARED
// sandboxIdFromToken in @intentic/sandbox-contract so the platform, CLI, and daemon derive the identical id
// from the token alone (no Cloudflare call). The platform always has a non-empty token, so undefined is a bug.
const sandboxTunnelId = (connectToken: string): string => {
    const id = sandboxIdFromToken(connectToken);
    if (id === undefined) throw new Error(`sandboxTunnelId called with an empty connect token`);
    return id;
};

// The stable public hostname for a sandbox's intentic tunnel, derivable from the token alone. The mint
// provisions the tunnel/DNS behind this name before returning it, so the wizard never probes an unresolvable
// hostname (an early NXDOMAIN gets negative-cached by resolvers for the zone's SOA TTL).
export const sandboxHostname = (zone: string, connectToken: string): string => sandboxHost(sandboxTunnelId(connectToken), zone);

export const provisionSandboxTunnel = async (args: {
    apiToken: string;
    zone: string;
    connectToken: string;
}): Promise<{ hostname: string; tunnelToken: string }> => {
    const id = sandboxTunnelId(args.connectToken);
    const name = sandboxSubdomain(id);
    const hostname = sandboxHost(id, args.zone);
    const tunnelToken = await provisionTunnel({
        apiToken: args.apiToken,
        zone: args.zone,
        name,
        routes: [
            { hostname, service: `http://intentic-sandbox-workspace:${DAEMON_PORT}`, comment: "intentic sandbox tunnel" },
            { hostname: sshHostname(id, args.zone), service: "ssh://intentic-sandbox-workspace:22", comment: "intentic sandbox ssh tunnel" },
        ],
    });
    return { hostname, tunnelToken };
};

// Tear down a sandbox's intentic-owned tunnel + its CNAMEs (sandbox-<id>, ssh-<id>) — the destroy half of
// provisionSandboxTunnel, called when the sandbox row is deleted. Only intentic-provided tunnels are ever
// passed here (the caller guards on the cached tunnelToken); own-Cloudflare tunnels belong to the user.
// Idempotent: a tunnel already gone (e.g. reaped) just finds nothing to delete.
export const deleteSandboxTunnel = async (args: { apiToken: string; zone: string; connectToken: string }): Promise<void> => {
    const { zoneId, accountId } = await resolveZone(args.apiToken, args.zone);
    const name = sandboxSubdomain(sandboxTunnelId(args.connectToken));
    const tunnels = await cfCall(
        args.apiToken,
        `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
        z.array(z.object({ id: z.string() })),
    );
    for (const tunnel of tunnels) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- at most one tunnel per name; sequenced deletes
        await deleteTunnelById(args.apiToken, accountId, zoneId, tunnel.id);
    }
};

// The in-container origin the sandbox preview proxy listens on — fixed like the daemon's :8787 and sshd's :22
// above. On the intentic-provided path the ingress is platform-owned, so a container-side PREVIEW_PORT
// override is not honored here.
const PREVIEW_SERVICE = `http://intentic-sandbox-workspace:${PREVIEW_PORT}`;

// A remotely-managed tunnel's current config. Parsed loosely so fields this code doesn't set (warp-routing,
// originRequest, …) survive the read-modify-PUT round-trip; config is null for a never-configured tunnel.
const tunnelConfigSchema = z.object({
    config: z.looseObject({ ingress: z.array(z.looseObject({ hostname: z.string().optional(), service: z.string() })).optional() }).nullable(),
});

// Ensure a preview route exists on the sandbox's intentic-owned tunnel for a label (`preview-<panel>` /
// `port-<slot>` — see hostnames.ts): a proxied CNAME `<label>-<id>.<zone>` → <tunnelId>.cfargotunnel.com plus
// an ingress rule → the preview proxy. Idempotent — the daemon calls it on every panel start / port forward;
// an already-routed hostname skips the config PUT, and the CNAME upsert repairs a half-failed earlier run. The
// PUT replaces the whole ingress list (Cloudflare has no append), so the current config is read and merged;
// the daemon serializes its calls, so two ensures at once can't race the read-modify-write.
export const ensurePreviewRoute = async (args: {
    apiToken: string;
    zone: string;
    connectToken: string;
    label: string;
}): Promise<{ hostname: string }> => {
    const id = sandboxTunnelId(args.connectToken);
    const hostname = labelHostname(args.label, id, args.zone);
    const { zoneId, accountId } = await resolveZone(args.apiToken, args.zone);
    const tunnels = await cfCall(
        args.apiToken,
        `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?name=${encodeURIComponent(sandboxSubdomain(id))}&is_deleted=false`,
        z.array(z.object({ id: z.string() })),
    );
    const tunnel = tunnels[0];
    if (tunnel === undefined) {
        throw new Error(`the sandbox tunnel "${sandboxSubdomain(id)}" was not found — re-run setup`);
    }
    const configPath = `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}/configurations`;
    const { config } = await cfCall(args.apiToken, configPath, tunnelConfigSchema);
    const ingress = config?.ingress ?? [CATCH_ALL];
    if (!ingress.some((rule) => "hostname" in rule && rule.hostname === hostname)) {
        // Insert above the trailing catch-all (cloudflared matches rules in order).
        const merged = [...ingress.slice(0, -1), { hostname, service: PREVIEW_SERVICE }, ...ingress.slice(-1)];
        await cfCall(args.apiToken, configPath, z.unknown(), {
            method: "PUT",
            body: JSON.stringify({ config: { ...config, ingress: merged } }),
        });
    }
    await upsertCname(args.apiToken, zoneId, hostname, cfargotunnelCname(tunnel.id), "intentic sandbox preview");
    return { hostname };
};

// Provision the intentic-owned per-host SSH tunnel that exposes a deploy target's sshd at `ssh-<id>.<zone>`, for
// sandboxes whose Cloudflare is intentic-provided (the user has no token that could create it). `<id>` digests
// (connection token + host name) — the EXACT scheme createHostSshTunnel in the sandbox CLI uses on the
// own-Cloudflare path — so each host gets its own tunnel and re-mints reuse it. The infra operator panel embeds
// the returned connector token + hostname in the connect-host one-liner in place of CF_TOKEN.
export const provisionHostSshTunnel = async (args: {
    apiToken: string;
    zone: string;
    connectToken: string;
    hostName: string;
}): Promise<{ hostname: string; tunnelToken: string }> => {
    const id = hostSshIdFromToken(args.connectToken, args.hostName);
    const hostname = sshHostname(id, args.zone);
    const tunnelToken = await provisionTunnel({
        apiToken: args.apiToken,
        zone: args.zone,
        name: hostSshTunnelName(id),
        routes: [{ hostname, service: "ssh://localhost:22", comment: "intentic host ssh tunnel" }],
    });
    return { hostname, tunnelToken };
};

// Only the platform's own bootstrap tunnels are reaped — engine/demo tunnels (git/deploy/app.<zone>) never
// match this prefix, so the filter is the reaper's safety boundary.
const REAPABLE_NAME = /^(sandbox|host-ssh)-/;

// A cfd_tunnel as the list endpoint returns it. status is "healthy"/"degraded"/"down"/"inactive" (null for a
// tunnel that has never connected); conns_active_at is the last time a connector was attached (null if never).
const tunnelSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.string().nullable(),
    conns_active_at: z.string().nullable(),
    created_at: z.string(),
});

// Every cfd_tunnel in the account (excluding soft-deleted). The cfd_tunnel list's result_info carries no
// total_pages (unlike /zones), so paginate by page-size: keep going while a page comes back full, stop on the
// first short page — the reaper exists precisely for accounts with more tunnels than one page holds.
const PER_PAGE = 50;
// Defensive cap: cfd_tunnel pagination has no total_pages, so we stop on the first short page — but a `page`-
// ignoring API bug that kept returning full pages would otherwise sweep forever. 200 pages (10k tunnels) is far
// above any real account; the reaper keeps the true count small.
const MAX_TUNNEL_PAGES = 200;
const listTunnels = async (apiToken: string, accountId: string): Promise<z.infer<typeof tunnelSchema>[]> => {
    const tunnels: z.infer<typeof tunnelSchema>[] = [];
    let page = 1;
    let pageCount = 0;
    do {
        // oxlint-disable-next-line eslint/no-await-in-loop -- pagination: the next page is only fetched once this one is known full
        const response = await fetch(
            `${BASE}/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?is_deleted=false&per_page=${PER_PAGE}&page=${page}`,
            {
                headers: { Authorization: `Bearer ${apiToken}` },
                signal: AbortSignal.timeout(30_000),
            },
        );
        if (response.status === 401 || response.status === 403) {
            throw new CloudflareTokenError("the intentic Cloudflare API token is invalid or lacks the Cloudflare Tunnel scope");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- reading this page's body before deciding whether a next page exists
        const envelope = envelopeSchema.parse(await response.json());
        if (!response.ok || !envelope.success) {
            const detail = envelope.errors.map((error) => `${error.code} ${error.message}`).join("; ");
            throw new Error(`Cloudflare GET /cfd_tunnel failed (HTTP ${response.status}): ${detail}`);
        }
        const parsed = z.array(tunnelSchema).parse(envelope.result);
        tunnels.push(...parsed);
        pageCount = parsed.length;
        page += 1;
    } while (pageCount === PER_PAGE && page <= MAX_TUNNEL_PAGES);
    if (pageCount === PER_PAGE) {
        throw new Error(
            `Cloudflare GET /cfd_tunnel still returned full pages at page ${MAX_TUNNEL_PAGES} — refusing to sweep further (the API may be ignoring the page param).`,
        );
    }
    return tunnels;
};

// Delete the dangling proxied CNAMEs (sandbox-<id>, ssh-<id>) that point at a reaped tunnel, found by content
// so we need no record of the hostnames — they all resolve to <tunnelId>.cfargotunnel.com.
const deleteTunnelDns = async (apiToken: string, zoneId: string, tunnelId: string): Promise<void> => {
    const content = cfargotunnelCname(tunnelId);
    const records = await cfCall(
        apiToken,
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&content=${encodeURIComponent(content)}`,
        z.array(z.object({ id: z.string() })),
    );
    for (const record of records) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of records per tunnel; sequenced to keep deletes simple
        await cfCall(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`, z.unknown(), {
            method: "DELETE",
        });
    }
};

// Tear down one tunnel by id — the shared destroy primitive for deleteSandboxTunnel and the reaper. Clear the
// connector registrations first: a just-stopped cloudflared can leave connections that still block the tunnel
// delete (1022). Then delete the tunnel and its dangling CNAMEs. A genuinely-live connector re-registers, so
// the tunnel delete may still 1022 — that propagates: deleteSandboxTunnel's router caller orphans it for the
// reaper, and the reaper skips it so a later sweep collects it once it is truly down.
const deleteTunnelById = async (apiToken: string, accountId: string, zoneId: string, tunnelId: string): Promise<void> => {
    await cfCall(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/connections`, z.unknown(), {
        method: "DELETE",
    });
    await cfCall(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`, z.unknown(), {
        method: "DELETE",
    });
    await deleteTunnelDns(apiToken, zoneId, tunnelId);
};

// Delete intentic-owned sandbox-*/host-ssh-* tunnels that have no live connector and have been idle past the
// grace period, plus their CNAMEs. A reap candidate is any in-scope tunnel whose status is NOT healthy or
// degraded (i.e. down, inactive, or null for one that never connected) AND whose last connector activity
// (conns_active_at, or created_at when it never connected) is older than the cutoff — so a just-minted tunnel
// whose connector hasn't started, and a live tunnel briefly down over a reboot (cloudflared runs --restart
// unless-stopped), are both spared. Each delete is independent: a still-live connector that re-registered
// between the list and the delete (1022) is skipped for a later sweep, and any other per-tunnel failure is
// reported via onError and counted — never aborting the run, so one stuck tunnel can't block the rest or
// poison every future sweep. `exclude` names the pre-provisioned pool tunnels (sandboxPool.ts): unclaimed,
// they look exactly like idle orphans (never connected), so the caller passes their names to spare the pool.
export const reapStaleTunnels = async (args: {
    apiToken: string;
    zone: string;
    reapAfterMs: number;
    dryRun: boolean;
    exclude: Set<string>;
    log: (tunnel: { id: string; name: string; status: string | null }) => void;
    onError: (tunnel: { id: string; name: string }, error: unknown) => void;
}): Promise<{ scanned: number; reaped: number; skipped: number; failed: number }> => {
    const { apiToken, zone, reapAfterMs, dryRun, exclude, log, onError } = args;
    const { zoneId, accountId } = await resolveZone(apiToken, zone);
    const tunnels = await listTunnels(apiToken, accountId);
    const cutoff = Date.now() - reapAfterMs;
    const stale = tunnels.filter((tunnel) => {
        if (!REAPABLE_NAME.test(tunnel.name) || exclude.has(tunnel.name) || tunnel.status === "healthy" || tunnel.status === "degraded") {
            return false;
        }
        return new Date(tunnel.conns_active_at ?? tunnel.created_at).getTime() < cutoff;
    });
    let reaped = 0;
    let skipped = 0;
    let failed = 0;
    for (const tunnel of stale) {
        log({ id: tunnel.id, name: tunnel.name, status: tunnel.status });
        if (dryRun) {
            continue;
        }
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequenced deletes keep Cloudflare rate limits comfortable
            await deleteTunnelById(apiToken, accountId, zoneId, tunnel.id);
            reaped += 1;
        } catch (error) {
            // A still-live connector re-registered between the list and the delete (1022) — not an orphan yet.
            if (error instanceof CloudflareApiError && error.codes.includes(1022)) {
                skipped += 1;
                continue;
            }
            failed += 1;
            onError({ id: tunnel.id, name: tunnel.name }, error);
        }
    }
    return { scanned: tunnels.length, reaped, skipped, failed };
};
