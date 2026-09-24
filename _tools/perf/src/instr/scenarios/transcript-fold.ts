import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import type { Scenario } from "../scenario.js";
import { agentTurn } from "../turn.js";

export const scenario: Scenario = {
    what: "the daemon's per-frame transcript fold (TranscriptFold.apply): a 900-call turn, 14,400 frames, patch by patch",
    setup: () => {
        const events = agentTurn(4, 900);
        const opening = [userRow("ship the review panel", 1_767_225_600_000, [])];
        return () => {
            const fold = new TranscriptFold(opening);
            let patches = 0;
            for (const event of events) {
                patches += fold.apply(event).length;
            }
            fold.finish("settled");
            if (fold.rows.length < 900) {
                throw new Error(`the fold produced ${fold.rows.length} rows for 900 calls`);
            }
            return patches;
        };
    },
};
