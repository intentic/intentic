import { fetchBrowsers, browsersKey } from "../../browser/browsersQuery";
import { capabilitiesKey, fetchCapabilities } from "../../extensions/useCapabilities";
import { draftsKey, fetchDrafts } from "../../extensions/useDrafts";
import { fetchPanels, panelsKey } from "../../extensions/usePanels";
import { fetchSubagents, subagentsKey } from "../../subagents/subagentsQuery";
import { fetchModules, modulesKey } from "../../workspace/useModules";
import { fetchWorkspaceTree, workspaceTreeKey } from "../../workspace/useWorkspaceTree";
import type { WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";

/* THE RAIL'S WISH LIST — the list behind each icon in the left column, so any of them opens with content in it.
 *
 * The lowest band, and the reasoning is the whole of why bands exist rather than priorities. None of this is
 * where the user is: it is where they might GO. So it is warmed with whatever is left after the board's cards
 * and the review's diffs are in hand — which on a quiet workspace is most of the time, and on a busy one is
 * rightly none of it.
 *
 * SEVERAL OF THESE ARE USUALLY WARM ALREADY, because the shell's own badges observe them from every page in the
 * app — the drafts queue, the panels the extension tiles are detected from, the running browsers and subagents.
 * Declaring them anyway costs a cache lookup per beat and covers the cases where the shell is not the one
 * asking: the phone's navigation, a window whose first paint beat the badge to it, and the moment after a
 * reconnect when everything is invalidated at once. The tree and the module layout are the two that are
 * genuinely cold — nothing observes them until the workspace itself is open.
 *
 * There is deliberately no entry here for an EXTENSION's own data. An extension that wants its view warm
 * registers its own source (warmPlan's registry is the public shape); a table of other people's queries kept in
 * the core is the list nobody remembers to extend. */

export const railWarmSource = (): readonly WarmTask[] => [
    // The workspace, first among these: it is the rail's other permanent surface, and the tree is what the whole
    // view is built out of.
    warmQuery(`rail:workspace-tree`, `rail`, workspaceTreeKey(), fetchWorkspaceTree),
    // The package layout the Changes panel groups its rows by — cheap, held long, and the difference between a
    // review that groups on arrival and one that regroups a beat later. (The agent review needs no entry here:
    // its layout rides its own diff, which this loader already warms.)
    warmQuery(`rail:workspace-modules`, `rail`, modulesKey(), fetchModules),
    warmQuery(`rail:drafts`, `rail`, draftsKey, fetchDrafts),
    warmQuery(`rail:panels`, `rail`, panelsKey, fetchPanels),
    warmQuery(`rail:capabilities`, `rail`, capabilitiesKey, fetchCapabilities),
    warmQuery(`rail:browsers`, `rail`, browsersKey, fetchBrowsers),
    warmQuery(`rail:subagents`, `rail`, subagentsKey, fetchSubagents),
];
