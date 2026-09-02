import { fetchBrowsers, browsersKey } from "../../browser/browsersQuery";
import { capabilitiesKey, fetchCapabilities } from "../../extensions/useCapabilities";
import { fetchPanels, panelsKey } from "../../extensions/usePanels";
import { fetchSubagents, subagentsKey } from "../../subagents/subagentsQuery";
import { fetchModules, modulesKey } from "../../workspace/useModules";
import { fetchWorkspaceTree, workspaceTreeKey } from "../../workspace/useWorkspaceTree";
import type { WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";

/* THE RAIL'S WISH LIST, the list behind each icon in the left column, so any of them opens with content in it.
 *
 * The lowest band, and the reasoning is the whole of why bands exist rather than priorities. None of this is
 * where the user is: it is where they might GO. So it is warmed with whatever is left after the board's cards
 * and the review's diffs are in hand, which on a quiet workspace is most of the time, and on a busy one is
 * rightly none of it.
 *
 * SEVERAL OF THESE ARE USUALLY WARM ALREADY, because the shell's own badges observe them from every page in the
 * app, the approvals queue, the panels the extension tiles are detected from, the running browsers and subagents.
 * Declaring them anyway costs a cache lookup per beat and covers the cases where the shell is not the one
 * asking: the phone's navigation, a window whose first paint beat the badge to it, and the moment after a
 * reconnect when everything is invalidated at once. The tree and the module layout are the two that are
 * genuinely cold, nothing observes them until the workspace itself is open.
 *
 * There is deliberately no entry here for an EXTENSION's own data, a table of other people's queries kept in
 * the core is the list nobody remembers to extend. An extension declares what its view wants on the view itself
 * (ViewRegistration.warm), and extensionsWarm next door collects them. That door had to be BUILT: this note
 * used to point at the plan's registry as "the public shape", which it was not, nothing in the extension API
 * reached it, so every rail tile the product ships as an extension went unwarmed while the note said otherwise. */

export const railWarmSource = (): readonly WarmTask[] => [
    // The workspace, first among these: it is the rail's other permanent surface, and the tree is what the whole
    // view is built out of.
    warmQuery(`rail:workspace-tree`, `rail`, { queryKey: workspaceTreeKey(), queryFn: fetchWorkspaceTree }),
    // The package layout the Changes panel groups its rows by, cheap, held long, and the difference between a
    // review that groups on arrival and one that regroups a beat later. (The agent review needs no entry here:
    // its layout rides its own diff, which this loader already warms.)
    warmQuery(`rail:workspace-modules`, `rail`, { queryKey: modulesKey(), queryFn: fetchModules }),
    warmQuery(`rail:panels`, `rail`, { queryKey: panelsKey, queryFn: fetchPanels }),
    warmQuery(`rail:capabilities`, `rail`, { queryKey: capabilitiesKey, queryFn: fetchCapabilities }),
    warmQuery(`rail:browsers`, `rail`, { queryKey: browsersKey, queryFn: fetchBrowsers }),
    warmQuery(`rail:subagents`, `rail`, { queryKey: subagentsKey, queryFn: fetchSubagents }),
];
