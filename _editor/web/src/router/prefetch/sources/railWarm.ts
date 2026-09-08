import { fetchBrowsers, browsersKey } from "../../../features/browsers/browsersQuery";
import { capabilitiesKey, fetchCapabilities } from "../../../features/capabilities/connect/useCapabilities";
import { fetchPanels, panelsKey } from "../../../features/extensions/usePanels";
import { fetchSubagents, subagentsKey } from "../../../features/chat/subagents/subagentsQuery";
import { fetchModules, modulesKey } from "../../../features/workspace/health/useModules";
import { fetchWorkspaceTree, workspaceTreeKey } from "../../../features/workspace/explorer/useWorkspaceTree";
import type { WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";

// Wish list behind each rail icon, at the lowest band since these are places the user might go, not is.
// Several are already warm via the shell's own badges; declared anyway to cover a phone's nav, a first
// paint, or a reconnect. Extension data belongs to the view itself (ViewRegistration.warm, see extensionsWarm).

export const railWarmSource = (): readonly WarmTask[] => [
    // The tree comes first: the rail's other permanent surface, and what the whole view is built from.
    warmQuery(`rail:workspace-tree`, `rail`, { queryKey: workspaceTreeKey(), queryFn: fetchWorkspaceTree }),
    // Layout the Changes panel groups rows by; the agent review needs no entry, its layout rides its own diff.
    warmQuery(`rail:workspace-modules`, `rail`, { queryKey: modulesKey(), queryFn: fetchModules }),
    warmQuery(`rail:panels`, `rail`, { queryKey: panelsKey, queryFn: fetchPanels }),
    warmQuery(`rail:capabilities`, `rail`, { queryKey: capabilitiesKey, queryFn: fetchCapabilities }),
    warmQuery(`rail:browsers`, `rail`, { queryKey: browsersKey, queryFn: fetchBrowsers }),
    warmQuery(`rail:subagents`, `rail`, { queryKey: subagentsKey, queryFn: fetchSubagents }),
];
