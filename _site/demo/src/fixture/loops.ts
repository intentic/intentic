import type { LoopDesign } from "@intentic/sandbox-contract";

/* THE SAVED LOOPS the demo workspace keeps, the other half of the composer's run-through picker.
 *
 * A loop and a workflow are the two answers to "what is this message run THROUGH", and the composer offers
 * them in one list under two headings. A demo daemon that served only the workflows half showed a visitor a
 * control with one section and no hint that the other exists, which teaches the opposite of what the merged
 * picker is for.
 *
 * TWO, and deliberately one of each KIND OF ENDING, because that is the distinction the picker's per-row line
 * exists to draw: one ends on a command whose exit code nobody can argue with, one ends on a reviewer agreeing.
 * A visitor reading the two rows side by side learns that "what stops it" is a thing a loop declares, before
 * they ever open the form that declares it.
 *
 * Both carry a spend ceiling for the reason the real picker puts one on the row: this is the one pick in the
 * composer that goes on spending after the person who armed it has looked away.
 */
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
