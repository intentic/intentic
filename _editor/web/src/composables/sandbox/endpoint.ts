import { localHostname, zoneFromUrl } from "@intentic/sandbox-contract";
import { localDaemonPort, localDaemonUrlInsecure } from "@intentic/sandbox-run";
import { sha256Hex } from "../workspace/contentHash";

/* WHICH ADDRESS THIS BROWSER DIALS TO REACH THE ACTIVE DAEMON, pure, so the whole selection policy is
 * testable without a network or a Vue instance (the same split connection.ts makes for the reconnect policy).
 *
 * A sandbox usually runs on the user's OWN machine, and reaching it means leaving the browser, crossing to a
 * Cloudflare edge, riding the tunnel to the connector container, and coming back, for a daemon that is a
 * loopback hop away. The container publishes 127.0.0.1:<port derived from the sandbox id> for exactly this,
 * and what follows decides whether to use it.
 *
 * The decision is NOT "are these the same machine". That question has no honest answer from a browser: a
 * shared public IP means a shared NAT (an office, a coffee shop), not a shared host, and nothing else is
 * visible. The answerable question is "does this address reach MY daemon", which is a probe, so this module
 * is candidates + a probe, in the shape ICE uses, and never an inference about topology.
 *
 * Two properties the probe must have, both learned from what goes wrong without them:
 *   • It must check IDENTITY, not just liveness. A port is not a sandbox. A second sandbox on this machine, a
 *     leftover container, or an unrelated dev server can answer there, and adopting it would point one
 *     sandbox's session, uploads and terminals at another's daemon. /health names the daemon; we require a
 *     match against the id we derived, which is the same digest the container published under.
 *   • It must be BOUNDED and cheap. It runs on every sandbox switch, and a candidate that hangs must cost a
 *     moment, not a workspace, so the tunnel keeps serving while this resolves and nothing waits on it.
 *
 * The selection is per browser and never written back to the platform: the same account opens this app from a
 * phone, where the local candidate is another machine's loopback and must never be reached for. */

// A local candidate that does not answer within this is not worth waiting on, loopback is sub-millisecond
// when it works, so anything approaching this is a hung socket, not a slow one. Deliberately far below the
// connection watchdog: this must resolve inside the time the tunnel would have taken to answer anyway.
const PROBE_TIMEOUT_MS = 1500;

/* Where a daemon call goes. `tunnel` is the sandbox's public URL (the platform's registry value, and the only
 * address that works from anywhere); the other two are the same loopback port, differing only in what the
 * daemon managed to serve on it.
 *
 * `local` is HTTPS on `<id>.local.<zone>`, a public name resolving to 127.0.0.1, the only form EVERY browser
 * accepts. `local-insecure` is plain http on 127.0.0.1; the mixed-content spec calls loopback
 * potentially-trustworthy so Chrome and Firefox take it, and Safari does not (WebKit 171934), which is
 * precisely why the certified form is tried first.
 *
 * The daemon serves BOTH on that one port, at the same time, deciding per connection (sandbox
 * loopback-listener.ts). That is what makes the second one worth probing rather than a form that stopped
 * existing the moment issuance landed. It also makes it the candidate that survives an outage: `local` is a
 * PUBLIC name, so reaching it costs a DNS lookup on the public internet, while `local-insecure` needs no name
 * at all. When the owner's connection drops, the tunnel goes with it and `<id>.local.<zone>` stops resolving; plain
 * loopback is then the only thing still standing between the browser and a daemon on the same machine. */
export type EndpointKind = "local" | "local-insecure" | "tunnel";

export interface Endpoint {
    readonly kind: EndpointKind;
    readonly base: string;
}

/* What the selection needs to know about a sandbox: its public address, the token the loopback port derives
 * from, and the two machine records that answer where it runs. Deliberately shaped as the fields a
 * `SandboxSummary` already carries, so a caller forwards facts rather than computing a verdict. */
export interface Addressing {
    readonly daemonUrl: string;
    readonly token: string | undefined;
    readonly cloud: object | null;
    readonly hosted: object | null;
}

/* Could the machine that runs this sandbox be the one this browser is on? NOT "is it", that is the question
 * the module header refuses, and it stays refused. This is the cheap NO: in two of the creation lanes the
 * platform built the machine itself and knows exactly where it is, its own hosted VM, or a machine in the
 * user's cloud provider account, and neither is ever a loopback hop from a browser.
 *
 * Worth its own gate rather than being left to the probe, because a probe here is not free. It is the app's
 * only reach for the machine the browser runs on, and Chrome answers that reach with a Local Network Access
 * prompt, so probing a sandbox that provably cannot be local spends the user's permission dialog, and their
 * reading of what this app does with their computer, on an address that could never have answered.
 *
 * Every other lane genuinely might be local: a `docker run` on the desktop in front of them, a sandbox
 * attached behind their own domain. Those keep the probe. */
export const couldBeOnThisMachine = (sandbox: Pick<Addressing, "cloud" | "hosted">): boolean => sandbox.cloud === null && sandbox.hosted === null;

/* The sandbox's 12-hex id, from the connect token this browser already holds, the WebCrypto twin of the
 * daemon/CLI/platform's `sandboxIdFromToken` (@intentic/sandbox-contract/tunnel-ids, which is node-only
 * because it reaches for node:crypto). hostnames.ts documents this split as the design: the id builders are
 * shared, and each side supplies the digest its runtime can compute.
 *
 * Derived from the TOKEN, not from the daemon URL: on the own-Cloudflare path the URL's leading label is
 * whatever subdomain the owner chose, while the published port always derives from the token, so reading the
 * id off the URL would compute a port nothing is listening on. */
export const sandboxIdOf = async (connectToken: string): Promise<string> => (await sha256Hex(connectToken)).slice(0, 12);

/* The certified loopback address: the daemon's own name (@intentic/sandbox-contract, where the whole hostname
 * family lives, and where the wildcard that resolves it is documented) on the port its container published
 * (@intentic/sandbox-run, which owns the derivation because it is what passes `-p` to docker).
 *
 * Composed here, in the module that DIALS it, rather than in either of those packages: it is the one address
 * that needs both, and neither package should have to depend on the other to spell it. Undefined where there
 * is no zone to certify under, which is a normal state, not a failure (see candidatesFor). */
export const localDaemonUrl = (sandboxId: string, zone: string | undefined): string | undefined =>
    zone === undefined || zone === `` ? undefined : `https://${localHostname(sandboxId, zone)}:${localDaemonPort(sandboxId)}`;

// The addresses worth trying for a sandbox, best first. Without a connect token there is no id, hence no
// derivable port and no local candidate at all, and a sandbox on a machine the platform placed elsewhere has
// nothing to reach for either, so both collapse to the tunnel being the only way in. The certified form leads;
// the plain one follows for the window before issuance lands, and forever where it cannot happen (no zone, an
// own-Cloudflare sandbox, a CA that refused).
export const candidatesFor = async (sandbox: Addressing): Promise<Endpoint[]> => {
    const tunnel: Endpoint = { kind: `tunnel`, base: sandbox.daemonUrl };
    if (sandbox.token === undefined || sandbox.token === `` || !couldBeOnThisMachine(sandbox)) {
        return [tunnel];
    }
    const id = await sandboxIdOf(sandbox.token);
    // The zone comes off the sandbox's PUBLIC url, the same one its tunnel hostname lives under, which is
    // where the daemon asked for the certificate.
    const secure = localDaemonUrl(id, zoneFromUrl(sandbox.daemonUrl));
    return [
        ...(secure === undefined ? [] : [{ kind: `local`, base: secure } as const]),
        { kind: `local-insecure`, base: localDaemonUrlInsecure(id) },
        tunnel,
    ];
};

/* IS THE ANSWER A WINDOW IS HOLDING STILL THE BEST ONE AVAILABLE, or is it the kind that goes stale?
 *
 * Two of the three are final. The tunnel always works, and the certified shortcut is the best address there
 * is, so a window holding either has nothing to gain from asking again. `local-insecure` is the odd one out,
 * because it is not really an answer to "where is this daemon" — it is the answer to "where is this daemon
 * REACHABLE FROM HERE YET", and yet is the whole problem. Issuance is a CA validating DNS, tens of seconds at
 * best, and a sandbox that has just been created has no certificate at all. So the ordinary sequence is: a
 * window opens, the certified name does not resolve, plain http qualifies, and the certificate lands a minute
 * later.
 *
 * Nothing re-asked. That window then spent the rest of its life on HTTP/1.1 with six connections per origin,
 * against a daemon that had been speaking h2 almost the whole time — and a healthy stream never reconnects, so
 * "the rest of its life" is hours. It is not a corner case either: it is what happens every single time
 * somebody opens a sandbox they just made.
 *
 * Hence provisional, and re-probed on an interval. The cost is one /health per minute against a name that
 * either resolves or does not, and only while a window is on the transport it would rather leave. */
export const PROMOTION_INTERVAL_MS = 60_000;

export const settledEndpoint = (endpoint: Endpoint | undefined, resolvedAt: number | undefined, now: number): boolean => {
    if (endpoint === undefined) {
        return false;
    }
    // No stamp is read as "just now" rather than "forever ago": an answer nobody dated cannot be aged out on
    // evidence that does not exist, and the next probe is one interval away at worst.
    return endpoint.kind !== `local-insecure` || now - (resolvedAt ?? now) < PROMOTION_INTERVAL_MS;
};

/* Does this address reach the daemon we mean? Unauthenticated (/health is exempt from the daemon's gate), so
 * a candidate can be qualified before any credential is presented to it, which matters, because presenting a
 * session bearer to whatever happens to hold a loopback port is precisely the mistake this prevents.
 *
 * Every failure mode collapses to `false` on purpose, because they are all the same instruction, use the
 * tunnel. Safari refusing the request as mixed content (it does not honour the spec's loopback exemption,
 * WebKit 171934), Chrome's Local Network Access permission being declined, nothing listening, a stranger
 * listening: none of them are worth telling apart, and none of them are errors the user should see. */
export const probeEndpoint = async (endpoint: Endpoint, expectedSandboxId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> => {
    if (endpoint.kind === `tunnel`) {
        return true; // the registry's own address: the fallback, never something we qualify
    }
    try {
        const response = await fetchImpl(`${endpoint.base}/health`, { cache: `no-store`, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!response.ok) {
            return false;
        }
        const body = (await response.json()) as { sandboxId?: unknown };
        return body.sandboxId === expectedSandboxId;
    } catch {
        return false;
    }
};

// The first candidate that answers as the sandbox we mean. The tunnel closes the list and is never probed, so
// this always resolves to something dialable, a sandbox with no working local shortcut is not a failure.
export const selectEndpoint = async (sandbox: Addressing, fetchImpl: typeof fetch = fetch): Promise<Endpoint> => {
    const candidates = await candidatesFor(sandbox);
    const expected = sandbox.token === undefined || sandbox.token === `` ? `` : await sandboxIdOf(sandbox.token);
    for (const candidate of candidates) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are ORDERED preferences: probing the rest in parallel would spend requests on addresses we would discard anyway
        if (await probeEndpoint(candidate, expected, fetchImpl)) {
            return candidate;
        }
    }
    // Unreachable while `candidatesFor` ends with the tunnel, which `probeEndpoint` always accepts.
    return { kind: `tunnel`, base: sandbox.daemonUrl };
};
