import type { PersonalDataClass } from "@intentic/sandbox-contract";

export interface PersonalDataSpan {
    readonly start: number;
    // Exclusive.
    readonly end: number;
    readonly class: PersonalDataClass;
    // Always text.slice(start, end).
    readonly value: string;
}

// Which class wins when two finds cover the same characters equally: a checksum is proof, an address or a phone is a
// shape, a name a guess. The address outranks the name inside it ("ul. Jana Pawła II 12" is an address).
const RANK = {
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

const better = (a: PersonalDataSpan, b: PersonalDataSpan): number =>
    b.end - b.start - (a.end - a.start) || RANK[b.class] - RANK[a.class] || a.start - b.start;

const overlaps = (a: PersonalDataSpan, b: PersonalDataSpan): boolean => a.start < b.end && b.start < a.end;

// Sorted by start and non-overlapping: where finds overlap, the longer stays, and on a tie the more specific class.
// Overlaps are settled within each cluster of finds that touch one another, which keeps the work linear in the number
// of finds however many there are, since a cluster is rarely more than two or three.
export const resolveSpans = (spans: readonly PersonalDataSpan[]): PersonalDataSpan[] => {
    const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
    const out: PersonalDataSpan[] = [];
    let cluster: PersonalDataSpan[] = [];
    let clusterEnd = -1;
    const settle = (): void => {
        if (cluster.length === 1 && cluster[0] !== undefined) {
            out.push(cluster[0]);
            return;
        }
        const kept: PersonalDataSpan[] = [];
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
