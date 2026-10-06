import type { LoopDesign } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// The contract's loopDesignLine in the reader's language: what ends the loop, then how far it may try. The rule is the
// contract's, said again here because its answer is one English line; loopDesignWords.test.ts holds the English of the
// two equal. A command that ends it is the command itself, and the spend ceiling stays in dollars as the contract writes
// it.
export const loopDesignWords = (design: LoopDesign): string => {
    const command = design.checks.find((check) => check.kind === `command`);
    const ends =
        command !== undefined
            ? command.command
            : design.checks.some((check) => check.kind === `judge`)
              ? t(`chat.loopDesign.reviewerAgrees`)
              : design.output.kind === `none`
                ? t(`chat.loopDesign.nothingChecks`)
                : t(`chat.loopDesign.agentSaysSo`);
    const rounds = t(`chat.loopDesign.rounds`, { count: design.maxIterations }, design.maxIterations);
    return [ends, rounds, ...(design.maxSpendUsd === undefined ? [] : [`$${design.maxSpendUsd}`])].join(` · `);
};
