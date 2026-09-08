import { localDaemonPort, localDaemonUrlInsecure } from "@intentic/sandbox-run";
import { sha256Hex } from "../../workspace/files/contentHash";

// Which address this browser dials for the active daemon: pure, so the policy is testable without a network.
// Never infers "same machine" (unanswerable from a browser); only asks "does this address reach my daemon" via a
// bounded, identity-checked probe, ICE-style. Per-browser only, never written back to the platform.

// Loopback answers sub-millisecond; near this means a hung socket, kept below the connection watchdog.
const PROBE_TIMEOUT_MS = 1500;

// Where a daemon call goes, by kind:
//   public: the platform's registered URL, reachable from anywhere.
//   local: HTTPS on a public name resolving to loopback (no CA can sign a loopback address itself).
//   local-insecure: plain HTTP on 127.0.0.1, refused by Safari as mixed content (WebKit 171934); the fallback
//     when DNS or the internet is down.
export type EndpointKind = "local" | "local-insecure" | "public";

export interface Endpoint {
    readonly kind: EndpointKind;
    readonly base: string;
}

// What endpoint selection needs about a sandbox: its public address, the token the loopback port derives from,
// and where it runs. Shaped to match `SandboxSummary`'s fields so a caller forwards facts rather than computing them.
export interface Addressing {
    readonly daemonUrl: string;
    readonly token: string | undefined;
    readonly hosted: object | null;
    // Certified loopback hostname as the platform reports it; null or absent means no certified shortcut exists.
    readonly localHostname?: string | null;
}

// Cheap NO, not a definite yes: true unless the platform hosts the machine itself (known non-local, e.g. Fly),
// since a probe here costs a Local Network Access prompt best not spent on an address that cannot answer.
export const couldBeOnThisMachine = (sandbox: Pick<Addressing, "hosted">): boolean => sandbox.hosted === null;

// 12-hex sandbox id from the connect token (WebCrypto twin of `sandboxIdFromToken`). Derived from the token, not
// the daemon URL: on own-Cloudflare, the URL's subdomain need not match the token-derived port.
export const sandboxIdOf = async (connectToken: string): Promise<string> => (await sha256Hex(connectToken)).slice(0, 12);

// Certified loopback address: hostname from the platform, port from the container's publish
// (@intentic/sandbox-run). The platform is the only source for the name.
export const certifiedLoopbackUrl = (sandboxId: string, hostname: string | null | undefined): string | undefined =>
    hostname === null || hostname === undefined || hostname === `` ? undefined : `https://${hostname}:${localDaemonPort(sandboxId)}`;

// Ranked by multiplexing, not distance: certified loopback and tunnel (both h2) outrank plain HTTP/1.1 (six
// connections per origin), which is only worth it when DNS or the internet is down entirely. No token, or a non-local
// machine, collapses to the tunnel alone.
export const candidatesFor = async (sandbox: Addressing): Promise<Endpoint[]> => {
    const tunnel: Endpoint = { kind: `public`, base: sandbox.daemonUrl };
    if (sandbox.token === undefined || sandbox.token === `` || !couldBeOnThisMachine(sandbox)) {
        return [tunnel];
    }
    const id = await sandboxIdOf(sandbox.token);
    // Hostname comes from the platform (Addressing); the port is still derived from the container's publish.
    const secure = certifiedLoopbackUrl(id, sandbox.localHostname);
    return [
        ...(secure === undefined ? [] : [{ kind: `local`, base: secure } as const]),
        tunnel,
        { kind: `local-insecure`, base: localDaemonUrlInsecure(id) },
    ];
};

// `local-insecure` is provisional, not final: unlike the other two kinds, a better address may appear as the
// network heals, so it is re-probed on this interval rather than trusted indefinitely.
export const PROMOTION_INTERVAL_MS = 60_000;

export const settledEndpoint = (endpoint: Endpoint | undefined, resolvedAt: number | undefined, now: number): boolean => {
    if (endpoint === undefined) {
        return false;
    }
    // A missing timestamp reads as "just now": an undated answer is not aged out on evidence that does not exist.
    return endpoint.kind !== `local-insecure` || now - (resolvedAt ?? now) < PROMOTION_INTERVAL_MS;
};

// Generous versus the loopback budget, so a slow-but-alive tunnel is not mistaken for a dead one.
const TUNNEL_PROBE_TIMEOUT_MS = 5000;

// Unauthenticated (`/health` bypasses the gate), so a candidate is identity-checked before any credential reaches
// it. Every failure mode returns `false`: they all mean the same thing, try the next candidate, none worth surfacing to
// the user.
export const healthAnswers = async (
    base: string,
    expectedSandboxId: string,
    budgetMs = TUNNEL_PROBE_TIMEOUT_MS,
    fetchImpl: typeof fetch = fetch,
): Promise<boolean> => {
    try {
        const response = await fetchImpl(`${base}/health`, { cache: `no-store`, signal: AbortSignal.timeout(budgetMs) });
        if (!response.ok) {
            return false;
        }
        const body = (await response.json()) as { sandboxId?: unknown };
        return body.sandboxId === expectedSandboxId;
    } catch {
        return false;
    }
};

// Same check as `healthAnswers`, picking the timeout budget by candidate kind. Kept separate because
// `sandboxSession` also probes an already-chosen address, not a list of candidates.
export const probeEndpoint = (endpoint: Endpoint, expectedSandboxId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> =>
    healthAnswers(endpoint.base, expectedSandboxId, endpoint.kind === `public` ? TUNNEL_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS, fetchImpl);

// Returns the first candidate that answers; the tunnel is trusted without a probe only when nothing follows it
// (the registry's own address). Loopback forms are never trusted untested: a port answering there is not proof it is
// this sandbox.
export const selectEndpoint = async (sandbox: Addressing, fetchImpl: typeof fetch = fetch): Promise<Endpoint> => {
    const candidates = await candidatesFor(sandbox);
    const expected = sandbox.token === undefined || sandbox.token === `` ? `` : await sandboxIdOf(sandbox.token);
    for (const [index, candidate] of candidates.entries()) {
        if (candidate.kind === `public` && index === candidates.length - 1) {
            return candidate;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are ORDERED preferences: probing the rest in parallel would spend requests on addresses we would discard anyway
        if (await probeEndpoint(candidate, expected, fetchImpl)) {
            return candidate;
        }
    }
    return { kind: `public`, base: sandbox.daemonUrl };
};
