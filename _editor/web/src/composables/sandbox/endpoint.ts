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

/* Where a daemon call goes. `public` is the sandbox's public URL (the platform's registry value, and the only
 * address that works from anywhere); the other two are the same loopback port, differing only in what the
 * daemon managed to serve on it.
 *
 * `local` is HTTPS on `<id>.local.<zone>`, a public name resolving to 127.0.0.1. HTTPS is not decoration here:
 * a browser trusts a certificate, a certificate needs a name a public CA will sign, and no CA can sign a
 * loopback ADDRESS (validation has to reach it from the public internet, and 127.0.0.1 is not routable —
 * true of Let's Encrypt's IP certificates too). A public name is the only way to put TLS, and therefore h2, on
 * a socket that never leaves the machine.
 *
 * `local-insecure` is plain http on 127.0.0.1; the mixed-content spec calls loopback potentially-trustworthy so
 * Chrome and Firefox take it from an HTTPS page, and Safari does not (WebKit 171934). It is HTTP/1.1 and cannot
 * be otherwise, because no browser speaks cleartext h2.
 *
 * The daemon serves BOTH on that one port, at the same time, deciding per connection (sandbox
 * loopback-listener.ts), so the plain form is a live alternative rather than a phase that ended when issuance
 * landed. What it is FOR is the outage: `local` is a public name, so reaching it costs a DNS lookup on the
 * public internet, and the tunnel needs the internet outright. When the owner's connection drops, both go with
 * it and plain loopback is the only thing still standing between the browser and a daemon on the same machine.
 * That, and only that, is when it is chosen — see candidatesFor for what ranking it any higher cost. */
export type EndpointKind = "local" | "local-insecure" | "public";

export interface Endpoint {
    readonly kind: EndpointKind;
    readonly base: string;
}

/* What the selection needs to know about a sandbox: its public address, the token the loopback port derives
 * from, and the machine record that answers where it runs. Deliberately shaped as the fields a
 * `SandboxSummary` already carries, so a caller forwards facts rather than computing a verdict. */
export interface Addressing {
    readonly daemonUrl: string;
    readonly token: string | undefined;
    readonly hosted: object | null;
    /* The name the daemon's loopback listener is certified under, as the PLATFORM reports it (its
     * `localHostname` on the sandbox summary). Null or absent where there is no certified shortcut to reach.
     *
     * Told rather than derived, and that distinction is the whole point. This used to be built here out of
     * `daemonUrl`'s zone, which is a different zone from the one holding the certificate the moment a sandbox's
     * reachability moves to the tunnel hub: the browser then probed `<id>.local.sbx.<zone>`, a name that
     * resolves to the hub rather than to loopback, failed, and fell through to plain http — HTTP/1.1, six
     * connections per origin, the transport everything else here exists to avoid. The platform owns the zone,
     * so the platform says the name and neither side guesses. */
    readonly localHostname?: string | null;
}

/* Could the machine that runs this sandbox be the one this browser is on? NOT "is it", that is the question
 * the module header refuses, and it stays refused. This is the cheap NO: when the platform hosts the machine
 * itself it knows exactly where it is, on Fly, in a region it chose, which is never a loopback hop from a
 * browser.
 *
 * Worth its own gate rather than being left to the probe, because a probe here is not free. It is the app's
 * only reach for the machine the browser runs on, and Chrome answers that reach with a Local Network Access
 * prompt, so probing a sandbox that provably cannot be local spends the user's permission dialog, and their
 * reading of what this app does with their computer, on an address that could never have answered.
 *
 * Anything else genuinely might be local: a `docker run` on the desktop in front of them, a sandbox attached
 * behind their own domain. Those keep the probe. */
export const couldBeOnThisMachine = (sandbox: Pick<Addressing, "hosted">): boolean => sandbox.hosted === null;

/* The sandbox's 12-hex id, from the connect token this browser already holds, the WebCrypto twin of the
 * daemon/CLI/platform's `sandboxIdFromToken` (@intentic/sandbox-contract/tunnel-ids, which is node-only
 * because it reaches for node:crypto). hostnames.ts documents this split as the design: the id builders are
 * shared, and each side supplies the digest its runtime can compute.
 *
 * Derived from the TOKEN, not from the daemon URL: on the own-Cloudflare path the URL's leading label is
 * whatever subdomain the owner chose, while the published port always derives from the token, so reading the
 * id off the URL would compute a port nothing is listening on. */
export const sandboxIdOf = async (connectToken: string): Promise<string> => (await sha256Hex(connectToken)).slice(0, 12);

/* The certified loopback address: the name the PLATFORM reports, on the port the container published
 * (@intentic/sandbox-run, which owns that derivation because it is what passes `-p` to docker).
 *
 * There was a `localDaemonUrl(id, zone)` here that built the name too, from the sandbox's own public zone. It
 * is gone rather than fixed: the bug was never the arithmetic, it was that this side had an opinion about the
 * name at all. One authority for it (the platform, which owns the DNS) and no second guess to drift. */
export const certifiedLoopbackUrl = (sandboxId: string, hostname: string | null | undefined): string | undefined =>
    hostname === null || hostname === undefined || hostname === `` ? undefined : `https://${hostname}:${localDaemonPort(sandboxId)}`;

/* THE ADDRESSES WORTH TRYING FOR A SANDBOX, BEST FIRST, and the order is a ranking by MULTIPLEXING before it
 * is a ranking by distance.
 *
 * Two of the three carry as many streams as this app wants on one connection: the certified loopback speaks
 * h2, and the tunnel's edge speaks h2 and advertises h3. The third cannot and never will: no browser speaks
 * cleartext h2, so `http://127.0.0.1` is HTTP/1.1 with SIX connections per origin, against an app that holds
 * a long-lived one per window plus one per streaming agent.
 *
 * It used to rank second, ahead of the tunnel, on the reasoning that a loopback hop beats a round trip to an
 * edge. It does — right up until the sixth connection, at which point every further request in every window of
 * this app queues in the browser until some stream ends. Measured: reads waiting 221 seconds against a daemon
 * answering in a mean of 66ms, with the tunnel sitting there healthy and unused the whole time. So the plain
 * form is LAST, and the price of choosing it is only ever paid when the alternative is nothing at all.
 *
 * That makes it what it was always described as and never was: the candidate for when the network is gone.
 * `local` is a public name, so it needs DNS; the tunnel needs the internet outright. When the owner's
 * connection drops, `http://127.0.0.1` is the only thing still standing between the browser and a daemon on
 * the same machine, and the tunnel probe ahead of it fails in milliseconds to get there.
 *
 * Without a connect token there is no id, hence no derivable port and no local candidate at all; a sandbox on
 * a machine the platform placed elsewhere has nothing to reach for either. Both collapse to the tunnel. */
export const candidatesFor = async (sandbox: Addressing): Promise<Endpoint[]> => {
    const tunnel: Endpoint = { kind: `public`, base: sandbox.daemonUrl };
    if (sandbox.token === undefined || sandbox.token === `` || !couldBeOnThisMachine(sandbox)) {
        return [tunnel];
    }
    const id = await sandboxIdOf(sandbox.token);
    // The certified name is the platform's answer, never a derivation from `daemonUrl` (see Addressing). The
    // PORT is still ours to derive: it is a property of the container's publish, not of anybody's DNS.
    const secure = certifiedLoopbackUrl(id, sandbox.localHostname);
    return [
        ...(secure === undefined ? [] : [{ kind: `local`, base: secure } as const]),
        tunnel,
        { kind: `local-insecure`, base: localDaemonUrlInsecure(id) },
    ];
};

/* IS THE ANSWER A WINDOW IS HOLDING STILL THE BEST ONE AVAILABLE, or is it the kind that goes stale?
 *
 * Two of the three are final. The certified shortcut is the best address there is, and the tunnel is the one
 * that works from anywhere, so a window holding either has nothing to gain from asking again.
 *
 * `local-insecure` is different in kind: since it ranks below the tunnel it is never a preference, it is a
 * VERDICT — "nothing multiplexed could be reached from here" — and a verdict about the network is exactly the
 * sort of thing that stops being true without telling anyone. Wifi comes back, the laptop wakes, the DNS
 * record is restored. Nothing re-asked, and a healthy stream never reconnects, so a window that qualified it
 * during a blip stayed on HTTP/1.1 with six connections per origin for hours afterwards.
 *
 * Hence provisional, and re-probed on an interval. The cost is one /health per minute, and only while a window
 * is on the transport it would rather leave. */
export const PROMOTION_INTERVAL_MS = 60_000;

export const settledEndpoint = (endpoint: Endpoint | undefined, resolvedAt: number | undefined, now: number): boolean => {
    if (endpoint === undefined) {
        return false;
    }
    // No stamp is read as "just now" rather than "forever ago": an answer nobody dated cannot be aged out on
    // evidence that does not exist, and the next probe is one interval away at worst.
    return endpoint.kind !== `local-insecure` || now - (resolvedAt ?? now) < PROMOTION_INTERVAL_MS;
};

/* The tunnel's own budget, far above the loopback one, because it is measuring something else entirely. A
 * loopback candidate is sub-millisecond when it works, so 1.5s there means "hung socket". The tunnel is a
 * Cloudflare edge plus a hop through the hub to a container that may be cold, and seconds are ordinary.
 *
 * Being generous costs nothing in the case that matters. An OFFLINE browser does not time this out, it fails
 * on DNS or a refused connection, in milliseconds, and falls straight through. The only thing this budget
 * buys is the reverse mistake: a tunnel that is alive but slow must not be mistaken for a dead one, because
 * the answer below it is HTTP/1.1 and six connections per origin. */
const TUNNEL_PROBE_TIMEOUT_MS = 5000;

/* Does this address reach the daemon we mean? Unauthenticated (/health is exempt from the daemon's gate), so
 * a candidate can be qualified before any credential is presented to it, which matters, because presenting a
 * session bearer to whatever happens to hold a loopback port is precisely the mistake this prevents.
 *
 * THE TUNNEL IS PROBED NOW TOO, which it never used to be. It was "the registry's own answer, the fallback,
 * never something we qualify", and that was coherent while it sat LAST: an address you fall back to needs no
 * qualifying, because there is nothing after it. It does not sit last any more (see candidatesFor), and an
 * unprobed candidate in the middle of a list is one that always wins, which would leave the plain-http
 * fallback behind it dead code and take the offline case with it.
 *
 * Every failure mode collapses to `false` on purpose, because they are all the same instruction, try the next
 * address. Safari refusing a loopback request as mixed content (it does not honour the spec's exemption,
 * WebKit 171934), Chrome's Local Network Access permission being declined, nothing listening, a stranger
 * listening, an edge that does not answer: none are worth telling apart, and none are errors the user should
 * see. */
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

/* The same question asked of a CANDIDATE, which is where the two budgets live: a loopback that works answers in
 * under a millisecond, an edge plus a hop to a cold container does not. Separate from the check itself because
 * the credential layer asks it too, of an address it has already chosen (sandboxSession), and it is not
 * choosing between candidates when it does. */
export const probeEndpoint = (endpoint: Endpoint, expectedSandboxId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> =>
    healthAnswers(endpoint.base, expectedSandboxId, endpoint.kind === `public` ? TUNNEL_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS, fetchImpl);

/* The first candidate that answers as the sandbox we mean, with the tunnel as the floor under all of them: it
 * is the registry's own address, so a sandbox whose every probe failed is still addressable rather than broken.
 *
 * A candidate with NOTHING AFTER IT is taken on trust, and only the tunnel is ever in that position. Qualifying
 * it would be spending a request to decide between it and nothing, and for a machine the platform placed
 * itself (a hosted VM) it is the only candidate there has ever been. The
 * loopback forms are never taken on trust at any position: a port is not a sandbox, and adopting whatever
 * happens to hold one would point this sandbox's session, uploads and terminals at another daemon. */
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
