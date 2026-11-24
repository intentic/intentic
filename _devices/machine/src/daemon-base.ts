import { randomBytes } from "node:crypto";
import { anySignal } from "@intentic/base/async";
import type { Log } from "@intentic/local-agent";
import { SANDBOX_ID } from "@intentic/sandbox-contract/ids/sandbox-id";
import { sandboxIdFromUrl } from "@intentic/sandbox-contract/ids/hostnames";
import { redeemWhileWarming } from "@intentic/sandbox-contract/pairing-redeem";
import {
    credentialDigest,
    PROOF_CHALLENGE_PARAM,
    PROOF_KEY_PARAM,
    proofKeyOf,
    provesLoopback,
} from "@intentic/sandbox-contract/protocol/doors/loopback-proof";
import { localDaemonUrlInsecure } from "@intentic/sandbox-run";
import { z } from "zod";

// Resolves which address reaches a sandbox's daemon: loopback when the container publishes one, else the public URL.
// Shared by both halves so they can't disagree on reachability. Loopback ranks first here, the opposite of the
// browser's own ordering, and is taken only from a daemon that proves it holds the digest of the very credential this
// agent is about to send it (2026-11-24, sandbox-contract protocol/doors/loopback-proof.ts). Until then any listener
// on the derived port that echoed the sandbox id in /health was handed the link token over plain ws: another account
// or container on this machine could bind the port, take the token, and push itself a grant with every switch on.

// Loopback answers in sub-millisecond time; past this it's a hung socket, cheaper to abandon than to keep racing the
// edge.
const PROBE_TIMEOUT_MS = 1500;

// The call surface this module uses; `typeof fetch` also carries bun's `preconnect`, which no injected impl has.
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// Port and /health's answer derive from this id, read off the public URL's label (the only source here).
export const daemonIdOf = (sandboxUrl: string): string | undefined => {
    const label = sandboxIdFromUrl(sandboxUrl);
    return label !== undefined && SANDBOX_ID.test(label) ? label : undefined;
};

// Best address first, public URL always last as the floor since it's the one that always works. Normalized of its
// trailing slash here, since the resolved base is compared as a string elsewhere.
export const candidateBases = (sandboxUrl: string): readonly string[] => {
    const floor = sandboxUrl.replace(/\/$/, "");
    const id = daemonIdOf(sandboxUrl);
    if (id === undefined) {
        return [floor];
    }
    const local = localDaemonUrlInsecure(id);
    // A public address that's already the loopback shortcut isn't probed again: same answer, wasted budget.
    return local === floor ? [floor] : [local, floor];
};

// The part of /health's answer a probe reads, from a daemon of any age: either field may be missing.
const ProbeAnswerSchema = z.object({ sandboxId: z.string().optional().catch(undefined), proof: z.string().optional().catch(undefined) });

// Whether `base` is this sandbox's daemon, proven against `token`, the credential about to be sent there: a fresh
// challenge each time, so an answer seen once is worth nothing again. Every failure (nothing listening, wrong daemon,
// a daemon from before the proof, mid-boot, hung socket, bad body) collapses to false: they all mean the same thing,
// try the next address.
export const probeDaemonBase = async (base: string, expectedId: string, token: string, fetchImpl: FetchImpl = fetch): Promise<boolean> => {
    const digest = credentialDigest(token);
    const challenge = randomBytes(32).toString("hex");
    const query = new URLSearchParams({ [PROOF_CHALLENGE_PARAM]: challenge, [PROOF_KEY_PARAM]: proofKeyOf(digest) });
    try {
        const response = await fetchImpl(`${base}/health?${query.toString()}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!response.ok) {
            return false;
        }
        const answer = ProbeAnswerSchema.safeParse(await response.json());
        return answer.success && answer.data.sandboxId === expectedId && provesLoopback(answer.data.proof ?? "", digest, expectedId, challenge);
    } catch {
        // allow(silent-catch): an address that cannot be asked is one that is not taken, which is the answer
        return false;
    }
};

// A resolved base and whether it's the loopback shortcut; `local` is carried, not recomputed, since the caching policy
// branches on it.
export interface DaemonBase {
    readonly base: string;
    readonly local: boolean;
}

// First candidate that proves itself the sandbox's daemon for `token`, the credential the caller is about to send it;
// the floor last and taken on trust (never probed). With no token there is nothing to prove with, so the answer is the
// floor. Every probe failure is absorbed, so this cannot reject.
export const resolveDaemonBase = async (sandboxUrl: string, token: string | undefined, fetchImpl: FetchImpl = fetch): Promise<DaemonBase> => {
    const candidates = candidateBases(sandboxUrl);
    const expected = daemonIdOf(sandboxUrl);
    for (const [index, candidate] of candidates.entries()) {
        if (index === candidates.length - 1) {
            return { base: candidate, local: false }; // The floor: the registry's own answer, taken on trust.
        }
        // Candidate order is the fallback order.
        if (expected !== undefined && token !== undefined && (await probeDaemonBase(candidate, expected, token, fetchImpl))) {
            return { base: candidate, local: true };
        }
    }
    // Unreachable while the floor is always last; only here to satisfy the compiler.
    return { base: sandboxUrl.replace(/\/$/, ""), local: false };
};

export interface WarmingAsk {
    // What the retry notes say is being done, e.g. "connecting".
    readonly doing: string;
    // Thrown on a 401: an expired pairing token is definitive, and retrying it only delays the fresh one.
    readonly expired: string;
    // Where each retry is narrated: the command's renderer, so it lands above its live line rather than across it.
    readonly say?: Log | undefined;
    readonly attempts?: number | undefined;
    readonly delayMs?: number | undefined;
}

// One try's ceiling: a warming sandbox answers 5xx in seconds, so a try past this is a connection nobody will answer.
const REDEEM_ATTEMPT_TIMEOUT_MS = 30_000;

// A POST through a tunnel that may still be warming: a network error or a 5xx is retried, anything else is the caller's.
export const postWhileWarming = async (sandboxUrl: string, path: string, init: RequestInit, ask: WarmingAsk): Promise<Response> => {
    const { doing, expired, say = () => undefined, attempts = 10, delayMs = 3000 } = ask;
    const outcome = await redeemWhileWarming(
        async (_attempt, signal) => {
            // Always the public address: a pairing token is not yet anything a daemon could prove it holds, and one a
            // stranger on the loopback port took would enroll the stranger.
            const { base } = await resolveDaemonBase(sandboxUrl, undefined);
            return fetch(`${base}${path}`, { ...init, method: "POST", signal: anySignal(signal, init.signal ?? undefined) });
        },
        {
            attempts,
            delayMs,
            // A tunnel that accepts the connection and never answers would otherwise hold the pairing forever.
            timeoutMs: REDEEM_ATTEMPT_TIMEOUT_MS,
            onRetry: (attempt, why) => {
                const said = why.kind === "unreachable" ? "the sandbox isn't reachable yet" : `the sandbox is warming up (HTTP ${why.status})`;
                say(`${doing}: ${said}, retrying (${attempt}/${attempts})…`);
            },
        },
    );
    if (outcome.kind === "unreachable") {
        throw outcome.error;
    }
    if (outcome.response.status === 401) {
        throw new Error(expired);
    }
    return outcome.response;
};

// The sync half's caching policy for resolve; the device half resolves once per dial and skips all of this
// (device/connection.ts).

// How often a fallback re-probes; a loopback verdict is re-checked only when the ports poll notices failure.
export const PROMOTION_INTERVAL_MS = 60_000;

// The fields a verdict is keyed and resolved by; structural rather than the sync half's Pairing, so this file owes it
// nothing. `syncToken` is what the sync half sends the daemon, so it is what a loopback daemon proves it holds; a
// pairing without one is dialled at its public address.
export interface DaemonTarget {
    readonly sandboxId: string;
    readonly sandboxUrl: string;
    readonly syncToken?: string | undefined;
}

interface Verdict extends DaemonBase {
    // When this verdict was reached; ages a provisional one out.
    readonly at: number;
    // Set by `failed`; marked rather than dropped, so a demotion is distinguishable from a first answer.
    readonly stale: boolean;
}

// The verdict per sandbox, held for the watcher's lifetime; `failed` reports that a dialler's given base let it down.
export interface DaemonBases {
    readonly resolve: (pairing: DaemonTarget) => Promise<string>;
    readonly failed: (sandboxId: string) => void;
}

// `now` and `fetchImpl` are injected so the promotion interval and probe are testable without waiting a minute or
// binding real ports.
export const createDaemonBases = (log: Log, fetchImpl: FetchImpl = fetch, now: () => number = Date.now): DaemonBases => {
    const held = new Map<string, Verdict>();
    return {
        resolve: async (pairing: DaemonTarget): Promise<string> => {
            const at = now();
            const kept = held.get(pairing.sandboxId);
            if (kept !== undefined && !kept.stale && (kept.local || at - kept.at < PROMOTION_INTERVAL_MS)) {
                return kept.base;
            }
            const verdict = await resolveDaemonBase(pairing.sandboxUrl, pairing.syncToken, fetchImpl);
            held.set(pairing.sandboxId, { ...verdict, at, stale: false });
            // Said only when the answer moved; an always-public pairing says nothing, the ordinary case.
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
        // Only a loopback verdict is dropped; a failing fallback is left alone since there's nothing else to fall to.
        failed: (sandboxId: string): void => {
            const kept = held.get(sandboxId);
            if (kept?.local === true) {
                held.set(sandboxId, { ...kept, stale: true });
            }
        },
    };
};

// One pairing plus where to dial it this pass; generic over the pairing so the sync half's shape rides through unnamed.
export interface Dialed<T extends DaemonTarget> {
    readonly pairing: T;
    readonly base: string;
}

// Resolves every pairing's base once per pass, in parallel, shared by the transport, ports poll and machine report.
export const dialedPairings = async <T extends DaemonTarget>(pairings: readonly T[], bases: DaemonBases): Promise<readonly Dialed<T>[]> =>
    await Promise.all(pairings.map(async (pairing) => ({ pairing, base: await bases.resolve(pairing) })));
