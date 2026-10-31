import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import type { Persona } from "@intentic/sandbox-contract/schemas/personas";
import type { WorkflowRun } from "@intentic/sandbox-contract/schemas/workflows";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref, watch } from "vue";
import { projectScope } from "../../../app/projectScope";
import { presenceOthers } from "../../../workbench/presence/usePresence";
import type { FleetLane } from "../../agent-status/agentStatus-lanes";
import { type FleetAgent, laneGroups } from "../useAgents-fleet";
import { insideRun, runIdsInLedger } from "../useWorkflowRuns";
import { boardOwners, type OwnerLook, ownerFilter } from "../../agent-status/ownership";
import { heldWakeInProject, runInProject } from "./projectMembership";
import { attentionHidden, scopeFleet } from "./scopeFleet";
import { type ChildFold, foldChildren, steadyFold } from "./childFold";

// Which of this sandbox's fleet the board covers: the open project, and whose work it is. Lanes group by one rule
// (laneGroups) either way, so no scope orders a column differently. Other sandboxes' fleets are Home's to show.

export { scopeFleet } from "./scopeFleet";

// A run's steps live inside its row, never as cards of their own. Gated on the ledger, not on the row being drawn:
// every reason a row is off screen (filter, window, archive) must take its conversations off the board too.
export const withoutSteps = (lanes: Record<FleetLane, FleetAgent[]>, ledger: ReadonlySet<string>): Record<FleetLane, FleetAgent[]> => {
    if (ledger.size === 0) {
        return lanes;
    }
    const outside = (agent: FleetAgent): boolean => !insideRun(agent, ledger);
    return { attention: lanes.attention.filter(outside), active: lanes.active.filter(outside), finished: lanes.finished.filter(outside) };
};

// What the project put out of sight, said on its chip so a quiet board is never mistaken for an empty fleet. Rows, not
// conversations: a hidden run's steps hide with it and count once, as the run does on the board, and a hidden
// parent's children count with it, riding under its card as they would (childFold).
export const hiddenByProject = (board: {
    readonly project: string | undefined;
    // Every card the board could show, and the ones the scope kept.
    readonly fleet: readonly FleetAgent[];
    readonly kept: readonly FleetAgent[];
    readonly ledger: ReadonlySet<string>;
    // The whole ledger, and the live rows the scope kept.
    readonly runs: readonly WorkflowRun[];
    readonly keptRuns: readonly WorkflowRun[];
    readonly held: readonly AutomationApproval[];
    readonly keptHeld: readonly AutomationApproval[];
}): number => {
    if (board.project === undefined) {
        return 0;
    }
    const shown = new Set(board.kept.map((agent) => agent.id));
    const hidden = foldChildren(laneGroups(board.fleet.filter((agent) => !shown.has(agent.id) && !insideRun(agent, board.ledger)))).lanes;
    const agents = hidden.attention.length + hidden.active.length + hidden.finished.length;
    const runs = board.runs.filter((run) => run.archivedAt === undefined).length - board.keptRuns.length;
    return agents + runs + board.held.length - board.keptHeld.length;
};

// The Everyone segment's value, since the filter's own `undefined` cannot be one.
const EVERYONE = `everyone`;

// Ownership as one exclusive choice: the lit segment names whose board this is, everybody else holding work on it is one
// press away, and it is the one place "mine" is spelled out, since cards draw nothing for the reader's own work.
export const ownerSegments = (me: string | undefined, owners: readonly OwnerLook[]) => [
    { label: t(`agents.agentsView.everyone`), value: EVERYONE, title: t(`agents.agentsView.mineOff`) },
    ...(me === undefined ? [] : [{ label: t(`agents.agentsView.mine`), value: me, title: t(`agents.agentsView.mineOnly`) }]),
    ...owners.map((look) => ({
        label: look.short,
        value: look.email,
        hue: look.hue,
        title: t(`agents.agentsView.onlyOwnedBy`, { name: look.name }),
    })),
];

export interface ScopeHost {
    // The fleet store, this sandbox's own: its cards, its lanes and its held wakes.
    readonly agents: {
        readonly fleet: Readonly<Ref<readonly FleetAgent[]>>;
        readonly lanes: Readonly<Ref<Record<FleetLane, FleetAgent[]>>>;
        readonly heldWakes: Readonly<Ref<readonly AutomationApproval[]>>;
    };
    // Every run the ledger holds, archived ones included.
    readonly runs: Readonly<Ref<readonly WorkflowRun[]>>;
    readonly personas: Readonly<Ref<readonly Persona[]>>;
    readonly me: Readonly<Ref<string | undefined>>;
    // Anyone but the reader can hold work here; without it, Everyone and Mine say the same thing.
    readonly sharedAccess: Readonly<Ref<boolean>>;
}

// The board's cards, held wakes and runs as the scope leaves them, and the header's controls that choose it.
export const useBoardScope = (host: ScopeHost) => {
    const { agents, personas } = host;
    const fleet = agents.fleet;
    const scopedFleet = computed(() =>
        scopeFleet(fleet.value, { project: projectScope.value, owner: ownerFilter.value, me: host.me.value, personas: personas.value }),
    );
    // Held wakes and runs narrow by the project's evidence alone, since nobody owns them yet.
    const scopedHeld = computed<readonly AutomationApproval[]>(() => {
        const project = projectScope.value;
        return project === undefined
            ? agents.heldWakes.value
            : agents.heldWakes.value.filter((wake) => heldWakeInProject(wake, project, personas.value, fleet.value));
    });
    const scopedRuns = computed<readonly WorkflowRun[]>(() => {
        const project = projectScope.value;
        return project === undefined ? host.runs.value : host.runs.value.filter((run) => runInProject(run, project, personas.value, fleet.value));
    });
    // An archived run is off the board like an archived agent, in Finished's archive instead.
    const boardRunRows = computed(() => scopedRuns.value.filter((run) => run.archivedAt === undefined));
    // The archive stays the sandbox's: its Delete all empties the whole pile, so its count must say the whole pile.
    const archivedRunRows = computed(() => host.runs.value.filter((run) => run.archivedAt !== undefined));
    const ledgerRunIds = computed(() => runIdsInLedger(host.runs.value));
    const projectHidden = computed(() =>
        hiddenByProject({
            project: projectScope.value,
            fleet: fleet.value,
            kept: scopedFleet.value,
            ledger: ledgerRunIds.value,
            runs: host.runs.value,
            keptRuns: boardRunRows.value,
            held: agents.heldWakes.value,
            keptHeld: scopedHeld.value,
        }),
    );
    // Items needing the reader that the open project keeps off the board, for the Attention lane to offer.
    const attentionElsewhere = computed(() =>
        attentionHidden({ fleet: agents.fleet.value, held: agents.heldWakes.value, personas: personas.value, project: projectScope.value, owner: undefined, me: host.me.value }),
    );
    // The store's own grouping while nothing narrows the board.
    const scopedLanes = computed<Record<FleetLane, FleetAgent[]>>(() =>
        projectScope.value !== undefined || ownerFilter.value !== undefined
            ? laneGroups(scopedFleet.value)
            : agents.lanes.value,
    );
    // The cards, less every run step and every child riding under its parent's card; the children the fold took, by card,
    // and the ones calling the reader through it.
    const folded = computed<ChildFold>((previous) => steadyFold(previous, foldChildren(withoutSteps(scopedLanes.value, ledgerRunIds.value))));
    const boardLanes = computed(() => folded.value.lanes);
    const boardChildren = computed(() => folded.value.children);
    const boardHosts = computed(() => folded.value.hosts);
    const boardCalls = computed(() => folded.value.calls);
    const boardFamilies = computed(() => folded.value.families);
    watch(host.sharedAccess, (shared) => {
        if (!shared) {
            ownerFilter.value = undefined;
        }
    });
    // The board's own roster, not the sandbox's member list: a colleague with nothing here has nothing to filter to.
    const ownerOptions = computed(() =>
        ownerSegments(host.me.value, boardOwners(fleet.value, host.me.value, presenceOthers.value, ownerFilter.value)),
    );
    const ownerScope = computed<string>({
        get: () => ownerFilter.value ?? EVERYONE,
        set: (value) => {
            ownerFilter.value = value === EVERYONE ? undefined : value;
        },
    });
    return {
        scopedHeld,
        boardRunRows,
        archivedRunRows,
        ledgerRunIds,
        projectHidden,
        attentionElsewhere,
        boardLanes,
        boardChildren,
        boardHosts,
        boardCalls,
        boardFamilies,
        ownerOptions,
        ownerScope,
    };
};
