import type { WorkspaceSearchResult } from "@intentic/sandbox-contract";
import type { Anchor, CaseScore } from "./schema.js";

export const DEFAULT_TOLERANCE = 10;
const CUTOFF = 10;

// One ranked retrieval unit as the agent consumes it: a file group with the lines iq surfaced in it.
export interface RankedAnchor {
    readonly file: string;
    readonly lines: readonly number[];
}

// Groups are already relevance-ranked and each is one rank, the unit an agent decides to open. `related`
// definition anchors ("name, def path:line · called from …") count as extra ranks after the groups, and so do the
// `candidates` anchors: all three are printed in one response, above the code, and each is a `path:line` the reader
// can open without asking iq anything else. Scoring only the groups charged iq for spending its budget on code,
// a file the candidates line anchored but did not show counted as not found, which is not what the agent sees.
export const rankedAnchors = (result: WorkspaceSearchResult): RankedAnchor[] => {
    const ranked: RankedAnchor[] = result.groups.map((group) => ({ file: group.path, lines: group.hits.map((hit) => hit.line) }));
    for (const entry of result.related ?? []) {
        const match = /def (\S+):(\d+)/.exec(entry);
        const file = match?.[1];
        const line = match?.[2];
        if (file === undefined || line === undefined) {
            continue;
        }
        ranked.push({ file, lines: [Number(line)] });
    }
    for (const anchor of result.candidates ?? []) {
        const match = /^(.*):(\d+)$/.exec(anchor);
        ranked.push(match === null ? { file: anchor, lines: [] } : { file: match[1]!, lines: [Number(match[2])] });
    }
    return ranked;
};

const matches = (expected: Anchor, candidate: RankedAnchor): boolean => {
    if (expected.file !== candidate.file) {
        return false;
    }
    const line = expected.line;
    if (line === undefined) {
        return true;
    }
    const tolerance = expected.tolerance ?? DEFAULT_TOLERANCE;
    return candidate.lines.some((candidateLine) => Math.abs(candidateLine - line) <= tolerance);
};

export interface RetrievalScore {
    readonly recallAt1: number;
    readonly recallAt5: number;
    readonly recallAt10: number;
    readonly mrr: number;
    readonly ndcg: number;
}

// Best ranks are computed per expected anchor independently (a single file group may satisfy several expected
// anchors, it is one retrieval unit), so binary nDCG is clamped to 1 when ranks coincide.
export const scoreCase = (expected: readonly Anchor[], predicted: readonly RankedAnchor[]): RetrievalScore => {
    const ranks = expected.map((anchor) => {
        const index = predicted.findIndex((candidate) => matches(anchor, candidate));
        return index === -1 ? undefined : index + 1;
    });
    const found = ranks.filter((rank) => rank !== undefined);
    const recallAt = (k: number): number => found.filter((rank) => rank <= k).length / expected.length;
    const best = found.length > 0 ? Math.min(...found) : undefined;
    const dcg = found.reduce((sum, rank) => (rank <= CUTOFF ? sum + 1 / Math.log2(rank + 1) : sum), 0);
    const idealCount = Math.min(expected.length, CUTOFF);
    let ideal = 0;
    for (let position = 1; position <= idealCount; position += 1) {
        ideal += 1 / Math.log2(position + 1);
    }
    return {
        recallAt1: recallAt(1),
        recallAt5: recallAt(5),
        recallAt10: recallAt(CUTOFF),
        mrr: best !== undefined && best <= CUTOFF ? 1 / best : 0,
        ndcg: Math.min(dcg / ideal, 1),
    };
};

export const meanScores = (scores: readonly CaseScore[]): CaseScore | undefined => {
    if (scores.length === 0) {
        return undefined;
    }
    const mean = (pick: (score: CaseScore) => number): number => scores.reduce((sum, score) => sum + pick(score), 0) / scores.length;
    return {
        recallAt1: mean((score) => score.recallAt1),
        recallAt5: mean((score) => score.recallAt5),
        recallAt10: mean((score) => score.recallAt10),
        mrr: mean((score) => score.mrr),
        ndcg: mean((score) => score.ndcg),
        tokens: mean((score) => score.tokens),
        latencyMs: mean((score) => score.latencyMs),
    };
};
