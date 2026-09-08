import type { LoopDesign } from "@intentic/sandbox-contract";

// Saved loops for the composer's run-through picker, alongside workflows. Two loops, one per ending kind: a command's
// exit code, or a reviewer agreeing. Both carry a spend ceiling since a loop keeps spending after it's armed.
export const demoLoops = (): LoopDesign[] => [
    {
        id: `until-green`,
        name: `Until the suite is green`,
        description: `Fix, run, fix again, the classic. Ends on the test command, not on the agent's opinion of it.`,
        context: `fresh`,
        output: { kind: `none` },
        checks: [{ kind: `command`, command: `pnpm test` }],
        maxIterations: 8,
        maxSpendUsd: 5,
        stallLimit: 2,
    },
    {
        id: `until-reviewed`,
        name: `Until a reviewer agrees`,
        description: `For the goals no command can check, "the README explains the auth flow". A second model reads the work each round.`,
        context: `continue`,
        output: { kind: `claim` },
        checks: [{ kind: `judge`, rubric: `The stated goal is met, and a newcomer could tell it was met without asking.` }],
        maxIterations: 5,
        maxSpendUsd: 3,
        stallLimit: 2,
    },
];
