import { applyEvents, intenticRun, startApply } from "./infrastructure";
import type { Doors } from "../doors";

// The in-sandbox CLI's runs over the declared infrastructure, streamed at the CLI's own pace (infrastructure.ts).
export const intenticDoors = {
    run: intenticRun,
    apply: startApply,
    applyEvents,
} satisfies Doors<`intentic`>;
