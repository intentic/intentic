import type { PanelSummary } from "@intentic/sandbox-contract/schemas/panels";
import { demoPanels } from "../../fixture/sandbox";
import { startPanel, stopPanel, withRuns } from "./panelRuns";
import type { Doors } from "../doors";
import { workspacePanels } from "../workspace/repos";

// Every repository the workspace holds, with the facts each extension's detect() runs over. A repository another store
// adds (a clone, a new repo) is appended here, so it can be started and stopped like the fixture's own.
const baseRows = (): PanelSummary[] => [...demoPanels(), ...workspacePanels()];

// The facts, with whatever the visitor has started running (daemon/panelRuns.ts) joined in.
export const panelsDoors = {
    list: () => ({ panels: withRuns(baseRows()) }),
    start: ({ repo }) => startPanel(baseRows(), repo),
    stop: ({ repo }) => stopPanel(baseRows(), repo),
} satisfies Doors<`panels`>;
