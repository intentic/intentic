import type { GroupSamples } from "./context.ts";

// GitHub's card is saved to the workstation, and a Devin account asked for, which nothing kept there answers.
export const hubSamples: GroupSamples<`hub`> = () => ({
    state: undefined,
    save: { target: { type: `card`, id: `github` }, machine: `rog` },
    take: { want: { type: `account`, provider: `devin` } },
});
