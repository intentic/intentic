import type { GroupSamples } from "./context.ts";

export const intenticSamples: GroupSamples<`intentic`> = () => ({
    run: { args: [`deploy`, `plan`] },
    apply: undefined,
    applyEvents: undefined,
});
