import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";

// Names as a reader sorts them: case and accents aside, and "box 2" before "box 10".
const byName = new Intl.Collator(undefined, { sensitivity: `base`, numeric: true });

/**
 * The order of the sandboxes on Home's rail and in the door up to it (otherSandboxes.ts). Unarranged, the reader's own
 * sandboxes lead the ones shared with them, each part by name. Arranged (`arranged`, the ids in the order the reader
 * dragged them to, sandboxOrder.ts), that order wins outright; a sandbox it does not name yet, one made or shared since,
 * follows the arranged ones in the unarranged order, where the add tile that made it stands.
 */
export const orderedSandboxes = <T extends { id: string; name: string; role: string }>(boxes: readonly T[], arranged: readonly string[] = []): T[] => {
    const rank = new Map(arranged.map((id, index) => [id, index]));
    const owned = (box: T): number => (box.role === `owner` ? 0 : 1);
    return boxes.toSorted(
        (left, right) =>
            (rank.get(left.id) ?? Infinity) - (rank.get(right.id) ?? Infinity) ||
            owned(left) - owned(right) ||
            byName.compare(left.name, right.name) ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
};

export interface AttentionReading {
    readonly needsYou?: number;
    readonly unreachable: boolean;
}

export const mergeAttention = (previous: AttentionReading | undefined, count: number | undefined): AttentionReading =>
    count === undefined ? { needsYou: previous?.needsYou, unreachable: true } : { needsYou: count, unreachable: false };

export const tileAction = (input: `click` | `enter`, sameTile: boolean, elapsed: number): `select` | `enter` =>
    input === `enter` || (sameTile && elapsed >= 0 && elapsed <= 300) ? `enter` : `select`;

export type WorkStage = `working` | `reviewing` | `testing` | `held` | `merged` | `landed` | `waiting`;
type Work = Pick<AgentSummary, `id` | `status` | `startedBy` | `fresh` | `updatedAt` | `landedMessage` | `title`>;

export const workStage = (worker: Work, checks: readonly Work[], home: Work | undefined, now: number): WorkStage => {
    if ([`running`, `resuming`, `stopping`, `landing`].includes(worker.status)) {
        return `working`;
    }
    if (worker.status === `landed`) {
        return home?.status === `landed` && home.updatedAt >= worker.updatedAt ? `landed` : `merged`;
    }
    const latest = checks
        .filter((check) => check.fresh?.kind === `review` || check.fresh?.kind === `test`)
        .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
    if (latest !== undefined && (latest.status === `running` || (latest.updatedAt >= worker.updatedAt && now - latest.updatedAt <= 30_000))) {
        return latest.fresh?.kind === `test` ? `testing` : `reviewing`;
    }
    return worker.status === `ready` ? `held` : `waiting`;
};

export const workLedger = (agents: readonly Work[], homeId: string, now: number) => {
    const home = agents.find((agent) => agent.id === homeId);
    return agents
        .filter((agent) => agent.startedBy === `agent:${homeId}` && (agent.fresh === undefined || agent.fresh.kind === `ask`))
        .map((worker) => {
            const checks = agents.filter((agent) => agent.fresh?.by === homeId && agent.fresh.of === worker.id && (agent.fresh.kind === `review` || agent.fresh.kind === `test`));
            const stage = workStage(worker, checks, home, now);
            return {
                worker,
                checks,
                stage,
                subject: stage === `landed` ? (home?.landedMessage?.subject ?? worker.landedMessage?.subject) : worker.landedMessage?.subject,
            };
        });
};
