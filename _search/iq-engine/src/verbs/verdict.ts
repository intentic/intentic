import type { Confidence, EngineHit } from "../types.js";

// The verdict on a reranked natural-language answer, the word the answer line ends on. It is worth printing only if it
// predicts whether the top answer is right: "confident" tells the reader to stop, "weak" that the thing may not exist.
//
// 2026-10-06: the old rule ("confident" for any gap of 0.05 between the two leading files, "weak" under a floor of 0.005)
// carried no signal. Over ~445 bare queries mined from transcripts "weak" fired once, "ambiguous" 60% of the time and
// "confident" 37%, 11% of the confident answers with a top rerank under 0.2; agents ran rg within five calls about as
// often after either word. A gap between two files says which leads, not whether the leader answers, so "confident"
// now also needs the top answer to be strong on its own. Thresholds are calibrated on iq-bench's `full` runs (its
// README, "Verdicts").

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

// The top file's best cross-encoder probability must reach this for the answer to read "confident" ...
export const CONFIDENT_FLOOR = 0.9;
// ... and lead the runner-up file's best by this much.
//   2026-10-06, on iq-bench's `full` run over click, hono and intentic (67 reranked answerable cases, the ui-copy and
//   route cases left out since literal and route answers never reach this rule; 12 no-answer): the old rule, a lead
//   of 0.05 and no floor, called 33 confident and 25 of them were right (76%), plus one no-answer case. A floor of 0.9
//   and a lead of 0.1 calls 15, 14 right (93%), and no no-answer case. 0.8/0.1 called 20 at 85%, 0.9/0.05 18 at 89%.
//   On 393 bare queries replayed from agent transcripts it fires on 16% of answers instead of 38%.
export const CONFIDENCE_MARGIN = 0.1;
// Below this cross-encoder probability for the best reranked passage, nothing retrieved likely answers and the answer
// line says "weak". The one absolute score: every other signal is relative to the best hit. Low on purpose, since this
// model scores some real code answers near zero, and calling a real answer weak costs more than missing a non-answer.
//   2026-10-06: raised from 0.005 to 0.05. On the same run the no-answer cases' best passages sat at 0.0007, 0.0010,
//   0.0021, 0.0022, 0.0032, 0.019, 0.038, 0.0498, then 0.46 to 0.91; the answerable ones at 0.0002, 0.0007, 0.010, then
//   0.11 and up. 0.05 catches 8 of 12 no-answer cases instead of 5, and calls 3 of 76 answerable ones weak instead of
//   2 (one of the three was not in the top 10 anyway). Replayed over 393 transcript queries it fires on 9 (2%; it had
//   fired on none), and none of those 9 sessions went on to open the file iq answered with.
export const WEAK_FLOOR = 0.05;

export const WEAK_HINT =
    "weak match: no result scored as a likely answer, so this may not exist here. Stop, or rephrase once in the code's own words; reading on through the candidates will not find it";

export interface VerdictSignals {
    // The top file's best cross-encoder probability.
    readonly top: number;
    // How far it leads the runner-up file's best (1 when the runner-up never reached the cross-encoder).
    readonly margin: number;
    // The best probability anywhere in the reranked pool.
    readonly relevance: number;
    // The query names something defined here (an identifier in the prose): whatever was asked about exists, so the
    // answer is never weak, only possibly in the wrong place.
    readonly named?: boolean;
}

// Weak wins over the margin: a clear gap between two passages that both fail to answer is still no answer.
export const confidenceOf = (signals: VerdictSignals): Confidence => {
    if (signals.relevance < WEAK_FLOOR && signals.named !== true) {
        return "weak";
    }
    return signals.top >= CONFIDENT_FLOOR && signals.margin >= CONFIDENCE_MARGIN ? "confident" : "ambiguous";
};

export interface FieldScores {
    // Probabilities of the top and runner-up FILES' best passages, in the order actually rendered; undefined when that
    // file never reached the cross-encoder.
    readonly top: number | undefined;
    readonly runnerUp: number | undefined;
}

// The top two FILES of the rendered order (post-RRF blending), not the two best passages: one file scoring well twice
// must not read as a close field.
export const fieldScores = (ordered: readonly { path: string }[], scored: readonly { hit: EngineHit; logit: number }[]): FieldScores => {
    const bestByPath = new Map<string, number>();
    for (const entry of scored) {
        const seen = bestByPath.get(entry.hit.path);
        if (seen === undefined || entry.logit > seen) {
            bestByPath.set(entry.hit.path, entry.logit);
        }
    }
    const scoreOf = (index: number): number | undefined => {
        const path = ordered[index]?.path;
        const logit = path === undefined ? undefined : bestByPath.get(path);
        return logit === undefined ? undefined : sigmoid(logit);
    };
    return { top: scoreOf(0), runnerUp: scoreOf(1) };
};

// The gap between them: 0 with no reranked leader (no signal), 1 when the runner-up was never scored (the widest gap,
// not missing data).
export const marginOf = (scores: FieldScores): number => {
    if (scores.top === undefined) {
        return 0;
    }
    return scores.runnerUp === undefined ? 1 : scores.top - scores.runnerUp;
};

export const fieldMargin = (ordered: readonly { path: string }[], scored: readonly { hit: EngineHit; logit: number }[]): number =>
    marginOf(fieldScores(ordered, scored));
