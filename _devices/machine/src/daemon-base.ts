import type { Log } from "@intentic/local-agent";
import { sandboxIdFromUrl } from "@intentic/sandbox-contract";
import { localDaemonUrlInsecure } from "@intentic/sandbox-run";

// Resolves which address reaches a sandbox's daemon: loopback when the container publishes one, else the public URL.
// Shared by both halves so they can't disagree on reachability. A candidate must prove its identity via /health before
// this agent trusts it with a token; loopback ranks first here, the opposite of the browser's own ordering.

// Loopback answers in sub-millisecond time; past this it's a hung socket, cheaper to abandon than to keep racing the
// edge.
const PROBE_TIMEOUT_MS = 1500;

// Port and /health's answer derive from this id, read off the public URL's label (the only source here).
const DAEMON_ID = /^[0-9a-f]{12}$/;

export const daemonIdOf = (sandboxUrl: string): string | undefined => {
    const label = sandboxIdFromUrl(sandboxUrl);
    return label !== undefined && DAEMON_ID.test(label) ? label : undefined;
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

// Every failure (nothing listening, wrong daemon, mid-boot, hung socket, bad body) collapses to false: they all mean
// the same thing, try the next address.
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

// A resolved base and whether it's the loopback shortcut; `local` is carried, not recomputed, since the caching policy
// branches on it.
export interface DaemonBase {
    readonly base: string;
    readonly local: boolean;
}

// First candidate that answers as the sandbox meant, floor last and taken on trust (never probed); every probe failure
// is absorbed, so this cannot reject.
export const resolveDaemonBase = async (sandboxUrl: string, fetchImpl: typeof fetch = fetch): Promise<DaemonBase> => {
    const candidates = candidateBases(sandboxUrl);
    const expected = daemonIdOf(sandboxUrl);
    for (const [index, candidate] of candidates.entries()) {
        if (index === candidates.length - 1) {
            return { base: candidate, local: false }; // The floor: the registry's own answer, taken on trust.
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates are ORDERED preferences: probing the rest in parallel would spend requests on addresses we would discard anyway
        if (expected !== undefined && (await probeDaemonBase(candidate, expected, fetchImpl))) {
            return { base: candidate, local: true };
        }
    }
    // Unreachable while the floor is always last; only here to satisfy the compiler.
    return { base: sandboxUrl.replace(/\/$/, ""), local: false };
};

// The sync half's caching policy for resolve; the device half resolves once per dial and skips all of this
// (device/connection.ts).

// How often a fallback re-probes; a loopback verdict is re-checked only when the ports poll notices failure.
export const PROMOTION_INTERVAL_MS = 60_000;

// The two fields a verdict is keyed and resolved by; structural rather than the sync half's Pairing, so this file owes
// it nothing.
export interface DaemonTarget {
    readonly sandboxId: string;
    readonly sandboxUrl: string;
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
