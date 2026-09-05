import type { Log } from "@intentic/local-agent";
import { sandboxIdFromUrl } from "@intentic/sandbox-contract";
import { localDaemonUrlInsecure } from "@intentic/sandbox-run";

/* WHICH ADDRESS THIS AGENT DIALS TO REACH A SANDBOX'S DAEMON, and the reason it is a question at all.
 *
 * A sandbox usually runs in a container ON THIS VERY MACHINE, and until now every byte this agent sent it left
 * the machine: the sync transport, the ports poll and the machine report all went to the sandbox's PUBLIC
 * address, out to the reachability edge and back down the tunnel to a container a loopback hop away. For a
 * Mutagen session that is not a rounding error — it is a multi-gigabyte checkout crossing the public internet
 * twice to land next to where it started, at the edge's throughput instead of the loopback's, on somebody's
 * home upload link.
 *
 * The container already publishes the daemon on `127.0.0.1:<port derived from the sandbox id>` for exactly
 * this, and the browser editor already dials it (_editor/web/src/composables/sandbox/endpoint.ts). This module
 * is that design on the node side: candidates plus an identity probe, never an inference about topology.
 *
 * BOTH HALVES DIAL THROUGH IT, which is why it sits in the shared root rather than beside the sync watcher that
 * first needed it. The device half's socket used to dial the public URL and nothing else, so a sandbox whose
 * tunnel was down — a dev box, an ingress mid-move, an edge answering 502 — showed its host capability
 * "offline" while the same binary's sync half was polling the container over loopback, a few lines up in the
 * same log. The Devices tab hangs every one of its controls on the host door (a button is that machine's own
 * CLI run over `run_command`), so that machine had folders, ports, a green badge and no buttons. One resolver
 * for every dial is what stops the two halves reaching the same container by different rules.
 *
 * The decision is NOT "is the sandbox on this machine". It is "does this address reach MY daemon", which is a
 * question a probe can answer, in the shape ICE uses.
 *
 * Two properties the probe must have, and both are load-bearing:
 *   • IDENTITY, not liveness. A port is not a sandbox. A second sandbox on this machine, a leftover container
 *     or an unrelated dev server can be listening there, and this agent's next act after choosing a base is to
 *     present a credential to it — the enrollment's SYNC TOKEN for the ports read, the machine report and the
 *     SSH stream carrying the user's whole workspace; the HOST TOKEN in the device socket's first frame, which
 *     is the durable key to running commands on this machine. Adopting a stranger's port would hand that
 *     credential, and then the file sync or the shell, to whatever happened to hold the number. So /health must
 *     name the daemon we mean. /health is unauthenticated precisely so this check costs no credential: the
 *     probe presents nothing, and only a candidate that has already proved its identity is ever dialled with a
 *     token.
 *   • BOUNDED and cheap. It runs per pairing on a watcher whose loop is sequential, and per attempt on a socket
 *     that reconnects on a backoff, so a candidate that hangs must cost a moment rather than a whole pass
 *     (mirror.ts's PORTS_TIMEOUT_MS exists for the same reason).
 *
 * WHERE THIS DEPARTS FROM THE BROWSER'S VERSION, deliberately: there, plain `http://127.0.0.1` ranks LAST,
 * below the tunnel, because no browser speaks cleartext h2 and six connections per origin throttles an app
 * holding a long-lived stream per window. None of that applies to a node agent — one SSH stream per Mutagen
 * connection over undici, no per-origin cap worth naming — so here loopback ranks FIRST and the public URL is
 * the floor. That inversion is why the fallback, not the loopback, is the verdict re-probed on an interval
 * below: the two sides put the same two addresses in the opposite order, so the answer that goes stale is the
 * opposite one too. */

/* A candidate that does not answer within this is not worth waiting on. Loopback is sub-millisecond when it is
 * real, so anything approaching this is a hung socket rather than a slow one — and the honest comparison is not
 * "is this generous" but "is this cheaper than the address it is racing", which is a round trip to an edge.
 *
 * Only ONE budget here, where endpoint.ts needs two: it probes the tunnel as well, because there the tunnel
 * sits mid-list and an unprobed candidate in the middle of a list always wins. Here the public URL is always
 * last, so it is never probed and never needs a budget of its own. */
const PROBE_TIMEOUT_MS = 1500;

/* THE DAEMON'S OWN 12-HEX ID, which is two things at once: the port the container published (the digest is what
 * `docker run` passed to `-p`) and the value /health answers with. One gate covers both, which is why they are
 * derived together here instead of separately at the two use sites.
 *
 * Read off the public URL's leading label, because that is all this side holds. The browser derives it from the
 * CONNECT token; this agent never sees that token — its credentials are the enrollment-minted sync and host
 * tokens, different secrets with different digests — so the URL is the only source available.
 *
 * Hence the 12-hex gate, and it is a correctness gate rather than validation theatre. On the intentic-provided
 * path the label IS `sandbox-<digest>`, so the derived port is the one the container published and the id is
 * what /health will say. On the own-Cloudflare path the label is whatever subdomain the owner chose: the port
 * derived from it is a number nothing published, and — the part that matters — there is no id to check an
 * answer against, so a daemon replying there could not be proved to be the right one. An unprovable candidate
 * is worse than no candidate, so those sandboxes get none and go straight to the floor. */
const DAEMON_ID = /^[0-9a-f]{12}$/;

export const daemonIdOf = (sandboxUrl: string): string | undefined => {
    const label = sandboxIdFromUrl(sandboxUrl);
    return label !== undefined && DAEMON_ID.test(label) ? label : undefined;
};

/* THE ADDRESSES WORTH TRYING FOR A SANDBOX, BEST FIRST, with the public URL last always.
 *
 * The public URL is the floor: it is the registry's own answer, the address the enrollment was performed
 * against, and the only one that works when the sandbox is somewhere else entirely. Every failure above it
 * collapses to "try the next one", so a sandbox whose probe fails is unchanged from before this module existed
 * rather than broken by it.
 *
 * Normalized of its trailing slash HERE, once, because the resolved base is COMPARED as a string: the tunnel
 * pool decides whether to rebind a listener by whether the base changed, and `https://x/` versus `https://x`
 * must not read as a move. (Each dialler still trims its own — they are each independently correct, and each
 * is reached by callers this module never sees.) */
export const candidateBases = (sandboxUrl: string): readonly string[] => {
    const floor = sandboxUrl.replace(/\/$/, "");
    const id = daemonIdOf(sandboxUrl);
    if (id === undefined) {
        return [floor];
    }
    const local = localDaemonUrlInsecure(id);
    // A sandbox whose public address IS the loopback shortcut (a dev box with SANDBOX_PUBLIC_URL on localhost)
    // would otherwise probe an address it is about to fall back to anyway: same answer, one wasted budget.
    return local === floor ? [floor] : [local, floor];
};

/* Does this address reach the daemon we mean? Unauthenticated, bounded, and every failure mode collapses to
 * `false` on purpose, because they are all the same instruction: try the next address. Nothing listening, a
 * stranger listening, a container mid-boot, a hung socket, a body that is not JSON — none are worth telling
 * apart, and none are faults the user should be shown. This is the one place in this agent where a swallowed
 * error is the design rather than a shortcut, so it is said out loud. */
export const probeDaemonBase = async (base: string, expectedId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> => {
    try {
        const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!response.ok) {
            return false;
        }
        const body = (await response.json()) as { sandboxId?: unknown };
        return body.sandboxId === expectedId;
    } catch {
        return false;
    }
};

// A resolved base and whether it is the loopback shortcut. `local` is carried rather than recomputed by
// comparing against the floor: it is what the caching policy branches on, and one derivation beats two.
export interface DaemonBase {
    readonly base: string;
    readonly local: boolean;
}

/* The first candidate that answers as the sandbox we mean, with the public URL as the floor under all of them.
 *
 * A candidate with NOTHING AFTER IT is taken on trust, and only the floor is ever in that position: probing it
 * would spend a request to choose between it and nothing. The loopback form is never taken on trust at any
 * position, for the reason in the header — a token goes to whatever this returns.
 *
 * Cannot reject. Every probe failure is absorbed above and the floor needs no probe, so a caller resolving a
 * whole pairing list in parallel needs no per-pairing guard, and a pairing can never lose its transport to a
 * resolution error.
 *
 * Takes the URL alone, because that is all either half holds in common: the sync half has a pairing and the
 * device half a link, and the address is the one field of both that is the sandbox's identity. */
export const resolveDaemonBase = async (sandboxUrl: string, fetchImpl: typeof fetch = fetch): Promise<DaemonBase> => {
    const candidates = candidateBases(sandboxUrl);
    const expected = daemonIdOf(sandboxUrl);
    for (const [index, candidate] of candidates.entries()) {
        if (index === candidates.length - 1) {
            return { base: candidate, local: false }; // the floor: the registry's own answer, taken on trust
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are ORDERED preferences: probing the rest in parallel would spend requests on addresses we would discard anyway
        if (expected !== undefined && (await probeDaemonBase(candidate, expected, fetchImpl))) {
            return { base: candidate, local: true };
        }
    }
    // Unreachable while the floor is last, which candidateBases guarantees; the compiler wants an answer and the
    // registry's address is the only honest one.
    return { base: sandboxUrl.replace(/\/$/, ""), local: false };
};

/* --- THE WATCHER'S CACHE ------------------------------------------------------------------------------------
 *
 * Everything below is the sync half's policy for asking the question above on a tick loop: the device
 * half's socket resolves once per dial attempt and needs none of it (device/connection.ts). It stays in this
 * file because a verdict's lifetime is inseparable from why it was reached (see the header's last paragraph on
 * which direction goes stale), and two files would put the rule and its reason apart. */

/* HOW OFTEN A PAIRING SITTING ON THE FALLBACK ASKS AGAIN, the provisional/settled distinction endpoint.ts
 * draws, pointed the other way (see the header).
 *
 * A LOOPBACK verdict is settled: it is the best address there is, so there is nothing to re-ask for. It is
 * re-examined only when it stops working, which the watcher notices for free — the ports poll runs against
 * this base every tick and is already the pairing's liveness probe.
 *
 * A FALLBACK verdict is provisional, because it is not a preference, it is a finding — "no daemon of mine
 * answers on loopback" — and a finding about the machine goes stale without telling anyone. The laptop starts
 * the sandbox after the watcher (a login where docker comes up second, a `docker compose up` an hour later, a
 * recreate), and nothing would re-ask: the watcher is resident for the whole session, so without this the
 * pairing spends the rest of the day pushing gigabytes through the edge while the container sits on loopback.
 * The cost of not letting that happen is one unauthenticated /health per minute per pairing. */
export const PROMOTION_INTERVAL_MS = 60_000;

// The two fields a verdict is keyed and resolved by. Structural rather than the sync half's `Pairing`, so a
// test names two fields rather than building a whole pairing, and so this file owes the sync half nothing.
export interface DaemonTarget {
    readonly sandboxId: string;
    readonly sandboxUrl: string;
}

interface Verdict extends DaemonBase {
    // When this verdict was reached, which is what ages a provisional one out.
    readonly at: number;
    /* Set by `failed`: this base let a dialler down, so it is re-probed on the next resolution however settled
     * its kind would otherwise be.
     *
     * MARKED RATHER THAN DROPPED, and the difference is not bookkeeping. Dropping the entry loses the only
     * record of what this pairing was using, so the resolution that replaces it cannot tell a demotion from a
     * first answer and says nothing at all — a container going away, the one transition here a user might need
     * to explain a suddenly slower sync, was silent. */
    readonly stale: boolean;
}

/* THE VERDICT PER SANDBOX, held for the watcher's lifetime, so the tick loop can ask on every pass and pay for
 * a probe only when the answer could have changed. `failed` is how a dialler reports that the base it was given
 * let it down. */
export interface DaemonBases {
    readonly resolve: (pairing: DaemonTarget) => Promise<string>;
    readonly failed: (sandboxId: string) => void;
}

/* `now` and `fetchImpl` are injected so the promotion interval and the probe are testable without waiting a
 * minute or binding the ports a real derivation lands on. */
export const createDaemonBases = (log: Log, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): DaemonBases => {
    const held = new Map<string, Verdict>();
    return {
        resolve: async (pairing: DaemonTarget): Promise<string> => {
            const at = now();
            const kept = held.get(pairing.sandboxId);
            if (kept !== undefined && !kept.stale && (kept.local || at - kept.at < PROMOTION_INTERVAL_MS)) {
                return kept.base;
            }
            const verdict = await resolveDaemonBase(pairing.sandboxUrl, fetchImpl);
            held.set(pairing.sandboxId, { ...verdict, at, stale: false });
            /* Said only when the answer MOVED, and the two directions are worth different words: one is an
             * optimization landing, the other is a container that went away. A pairing that has always used the
             * public address says nothing at all — that is the ordinary case and its address is already on
             * every other line of this log. */
            if (kept !== undefined && kept.base === verdict.base) {
                return verdict.base;
            }
            if (verdict.local) {
                log(`  ${pairing.sandboxId}: its daemon answers on ${verdict.base}; syncing over loopback instead of ${pairing.sandboxUrl}.`);
            } else if (kept !== undefined) {
                log(`  ${pairing.sandboxId}: the loopback daemon stopped answering as this sandbox; back to ${verdict.base}.`);
            }
            return verdict.base;
        },
        /* A base that just failed the caller. Only a LOOPBACK verdict is dropped: it is the one that can become
         * wrong (the container stopped, or was recreated onto another port), and dropping it makes the next
         * resolution re-probe and fall back to the floor rather than erroring the pairing.
         *
         * A failing FALLBACK is left alone on purpose. There is nothing under it to fall to, so clearing it
         * would buy a probe on every tick of an unreachable sandbox — which is the ordinary state of a laptop
         * whose sandbox is asleep — and change nothing about the answer. Its own interval re-asks soon enough. */
        failed: (sandboxId: string): void => {
            const kept = held.get(sandboxId);
            if (kept?.local === true) {
                held.set(sandboxId, { ...kept, stale: true });
            }
        },
    };
};

// One pairing plus where to dial it this pass. Everything downstream of resolution takes this instead of a
// bare pairing, so the base arrives by construction and no caller has to remember to look one up (or has
// anywhere to fall back to if it forgets). Generic over the pairing so the sync half's own shape rides through
// without this file naming it.
export interface Dialed<T extends DaemonTarget> {
    readonly pairing: T;
    readonly base: string;
}

/* EVERY PAIRING'S BASE FOR ONE PASS, resolved once and shared by the three things that dial: the SSH transport,
 * the ports poll and the machine report. One resolution point per pairing per tick is what keeps "re-resolve
 * every tick" from meaning "probe every tick" — the cache decides, and in the steady state this is a map lookup.
 *
 * In parallel because the pairings are independent sandboxes and a cold pass would otherwise serialize a probe
 * budget per pairing ahead of all the work. Cannot reject (see resolveDaemonBase). */
export const dialedPairings = async <T extends DaemonTarget>(pairings: readonly T[], bases: DaemonBases): Promise<readonly Dialed<T>[]> =>
    await Promise.all(pairings.map(async (pairing) => ({ pairing, base: await bases.resolve(pairing) })));
