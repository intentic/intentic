import type { PersonalDataClass } from "@intentic/sandbox-contract/schemas/privacy";

export interface PersonalDataSpan {
    readonly start: number;
    // Exclusive.
    readonly end: number;
    readonly class: PersonalDataClass;
    // Always text.slice(start, end).
    readonly value: string;
}

// What proposed a span, which is what it has to show before it is masked (detect.ts `createGate`). Read in context:
// the built-in detectors. The owner's own word: a rule of theirs, a value they taught. Proposed without the context it
// was once found in: a value the vault learned from an earlier find, and the local name model's guess.
export type SpanSource = "taught" | "learned" | "detector" | "rule" | "model";

export interface Candidate extends PersonalDataSpan {
    readonly by: SpanSource;
}

// Which class wins when two finds cover the same characters equally: a checksum is proof, an address or a phone is a
// shape, a name a guess. The address outranks the name inside it ("ul. Jana Pawła II 12" is an address).
const CLASS_RANK = {
    "national-id": 5,
    "tax-id": 5,
    "identity-document": 5,
    "bank-account": 5,
    "payment-card": 5,
    email: 4,
    phone: 4,
    address: 3,
    "person-name": 2,
} as const satisfies Record<PersonalDataClass, number>;

// And which source, before the class: a value the vault holds keeps the token it has, a detector's find stands over a
// rule's (so the vault goes on matching it after the rule is switched off), and the model only adds what no other found.
const SOURCE_RANK = { taught: 4, learned: 4, detector: 3, rule: 2, model: 1 } as const satisfies Record<SpanSource, number>;

const better = (a: Candidate, b: Candidate): number =>
    b.end - b.start - (a.end - a.start) || SOURCE_RANK[b.by] - SOURCE_RANK[a.by] || CLASS_RANK[b.class] - CLASS_RANK[a.class] || a.start - b.start;

const overlaps = (a: PersonalDataSpan, b: PersonalDataSpan): boolean => a.start < b.end && b.start < a.end;

// Sorted by start and non-overlapping: where finds overlap, the longer stays, then the better source, then the more
// specific class. Overlaps are settled within each cluster of finds that touch one another, which keeps the work linear in
// the number of finds however many there are, since a cluster is rarely more than two or three.
export const resolveSpans = <T extends Candidate>(spans: readonly T[]): T[] => {
    const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
    const out: T[] = [];
    let cluster: T[] = [];
    let clusterEnd = -1;
    const settle = (): void => {
        if (cluster.length === 1 && cluster[0] !== undefined) {
            out.push(cluster[0]);
            return;
        }
        const kept: T[] = [];
        for (const span of [...cluster].sort(better)) {
            if (!kept.some((other) => overlaps(span, other))) {
                kept.push(span);
            }
        }
        out.push(...kept.sort((a, b) => a.start - b.start));
    };
    for (const span of sorted) {
        if (span.end <= span.start) {
            continue;
        }
        if (cluster.length > 0 && span.start >= clusterEnd) {
            settle();
            cluster = [];
        }
        cluster.push(span);
        clusterEnd = Math.max(clusterEnd, span.end);
    }
    if (cluster.length > 0) {
        settle();
    }
    return out;
};
