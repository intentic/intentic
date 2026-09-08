import { fetchTerminals, terminalsKey } from "../../../features/terminal/terminalsQuery";
import { useLayout } from "../../../shell/window/useLayout";
import type { WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";

// Warms the sandbox's terminal list; the panel restores itself open per sandbox with nothing to show
// until this lands. `now` while the panel is open (the strip can't draw without it), `rail` while closed,
// beside the rail's own terminal badge. One cache entry backs the badge, rows and strip (terminalsQuery.ts).

export const terminalsWarmSource = (): readonly WarmTask[] => [
    warmQuery(`terminals:list`, useLayout().terminalOpen.value ? `now` : `rail`, { queryKey: terminalsKey, queryFn: fetchTerminals }),
];
