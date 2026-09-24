import { TranscriptRowSchema } from "@intentic/sandbox-contract";
import { foldTurn, userRow } from "@intentic/sandbox-contract/transcript-fold";
import type { Scenario } from "../scenario.js";
import { agentTurn } from "../turn.js";

export const scenario: Scenario = {
    what: "reading a stored transcript back (JSON.parse + TranscriptRowSchema.safeParse per line): 20 settled 150-call turns",
    setup: () => {
        const lines = Array.from({ length: 20 }, (_, turn) =>
            foldTurn([userRow(`turn ${turn}`, 1_767_225_600_000 + turn, [])], agentTurn(5 + turn, 150)),
        )
            .flat()
            .map((row) => JSON.stringify(row));
        return () => {
            let parsed = 0;
            for (const line of lines) {
                parsed += TranscriptRowSchema.safeParse(JSON.parse(line)).success ? 1 : 0;
            }
            if (parsed !== lines.length) {
                throw new Error(`${lines.length - parsed} of ${lines.length} stored rows failed their own schema`);
            }
            return parsed;
        };
    },
};
