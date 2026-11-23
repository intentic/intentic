import { join } from "node:path";
import type { FromNode } from "@intentic/sandbox-contract/netd-wire";
import type { RunnerUplinksReport } from "../../netd/netd-link.js";
import { runnerEnrollmentsDocument } from "../../peers/enrollment.js";
import { openDocument } from "../../store/open-document.js";

/* The parent's half of its runners' uplinks netd holds (netd's uplinks.rs, 2026-11-23): every enrolled runner is
   registered with netd by its enrollment's token digest (the SHA-256 hex the enrollment already keeps, the same digest
   netd computes of the token a dial presents), and every runner netd holds that is no longer enrolled (revoked, removed)
   is withdrawn, which closes its uplink. netd keeps registrations across a daemon restart, so this learns what netd holds
   from netd's first report after the hello, and a netd older than runner uplinks never reports: nothing is sent to it,
   since an older netd closes the link on a frame kind it does not know. Reconciled on every report and on a timer, so a
   revocation reaches netd within one beat without the peer store having to say so. */

// How often enrollments are read against what netd holds.
const RUNNER_UPLINK_BEAT_MS = 10_000;

// netd's name rule (uplinks.rs `is_name`): a runner it would refuse is never sent, rather than sent every beat.
const NETD_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface EnrolledRunner {
    readonly id: string;
    // Lowercase hex SHA-256 of the runner's durable token.
    readonly hash: string;
}

// Every enrolled runner and its digest, or undefined when the manifest cannot be read now: then nothing is withdrawn.
export type EnrolledRunners = () => Promise<readonly EnrolledRunner[] | undefined>;

export interface RunnerUplinks {
    // Whether this netd carries runner uplinks: it has reported at least once.
    readonly supported: () => boolean;
    readonly connected: (runner: string) => boolean;
    // netd's report, from the link (netd-door.ts).
    readonly heard: (report: RunnerUplinksReport) => void;
    // Reads the enrollments and brings netd in line with them, once it has reported.
    readonly reconcile: () => Promise<void>;
    readonly stop: () => void;
}

// The runner enrollments as /history holds them, digests included; read-only here (peers/enrollment.ts writes them).
export const enrolledRunnersAt = (historyRoot: string): EnrolledRunners => {
    const file = openDocument(runnerEnrollmentsDocument, join(historyRoot, runnerEnrollmentsDocument.path), {
        fallback: () => ({ runners: [] }),
        mode: 0o600,
        onUnreadable: "refuse",
    });
    return async () => {
        const stored = await file.state();
        return stored.unreadable ? undefined : stored.value.runners.map(({ id, hash }) => ({ id, hash }));
    };
};

export const runnerUplinks = (
    tell: (message: FromNode) => void,
    enrolled: EnrolledRunners,
    onError: (error: Error) => void,
    beatMs: number = RUNNER_UPLINK_BEAT_MS,
): RunnerUplinks => {
    let known: Map<string, boolean> | undefined;
    // The digest last sent per runner, so a repeat sends nothing.
    const sent = new Map<string, string>();
    let reconciling = Promise.resolve();
    const reconcileNow = async (): Promise<void> => {
        if (known === undefined) {
            return;
        }
        const runners = await enrolled();
        if (runners === undefined || known === undefined) {
            return;
        }
        const wanted = new Map(runners.filter(({ id, hash }) => NETD_NAME.test(id) && DIGEST.test(hash)).map(({ id, hash }) => [id, hash]));
        for (const [runner, digest] of wanted) {
            if (sent.get(runner) !== digest || !known.has(runner)) {
                sent.set(runner, digest);
                // Held as registered until netd's report says otherwise, so a reconcile before it sends nothing again.
                known.set(runner, known.get(runner) ?? false);
                tell({ kind: "runnerUplink", runner, tokenSha256: digest });
            }
        }
        for (const runner of new Set([...known.keys(), ...sent.keys()])) {
            if (!wanted.has(runner)) {
                sent.delete(runner);
                known.delete(runner);
                tell({ kind: "runnerWithdraw", runner });
            }
        }
    };
    // One reconcile at a time, each reading the enrollments when its turn comes.
    const reconcile = (): Promise<void> => {
        reconciling = reconciling.then(reconcileNow).catch(onError);
        return reconciling;
    };
    const timer = setInterval(() => void reconcile(), beatMs);
    timer.unref?.();
    return {
        supported: () => known !== undefined,
        connected: (runner) => known?.get(runner) === true,
        heard: (report) => {
            known = new Map(report.uplinks.map((uplink) => [uplink.runner, uplink.connected]));
            void reconcile();
        },
        reconcile,
        stop: () => clearInterval(timer),
    };
};
