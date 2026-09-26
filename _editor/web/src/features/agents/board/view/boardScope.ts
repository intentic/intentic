import type { AutomationApproval, Persona, WorkflowRun } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { computed, onUnmounted, type Ref, watch } from "vue";
import { projectScope } from "../../../../app/projectScope";
import { hold } from "../../../../shell/notifications/notifications";
import { presenceOthers } from "../../../../shell/presence/usePresence";
import { refreshAcross } from "../../../sandbox/live/fleetAcross";
import { type FleetLane, unregistered } from "../../fleet/agentStatus";
import { otherFleet, partialAnswer, readingAcross } from "../../fleet/fleetScope";
import { type FleetAgent, laneGroups } from "../../fleet/useAgents-fleet";
import { insideRun, runIdsInLedger } from "../../fleet/useWorkflowRuns";
import { followOtherBoxes } from "../agentsTile";
import { boardOwners, type OwnerLook, ownedBy, ownerFilter, sameAddress } from "../ownership";
import { agentInProject, heldWakeInProject, runInProject } from "../projectMembership";

// Which of the fleet the board covers: the open project, whose work it is, and whether every other sandbox's roster
// joins this one's. Lanes group by one rule (laneGroups) either way, so no scope orders a column differently; a sandbox
// is never a column or a sort key, which would rebuild the very problem the wide board exists to solve.

// The narrowing the reader chose; `project` and `owner` are undefined for all of them.
export interface Scope {
    readonly project: string | undefined;
    readonly owner: string | undefined;
    readonly me: string | undefined;
    readonly personas: readonly Persona[];
}

// A draft not yet sent stays under the project it was opened in, having no record to say so yet, and under Mine and
// everybody's, being about to be the reader's own; never under a colleague's chip, where it would not belong.
export const scopeFleet = (fleet: readonly FleetAgent[], { project, owner, me, personas }: Scope): FleetAgent[] => {
    const keepsDrafts = owner === undefined || sameAddress(owner, me);
    return fleet.filter(
        (agent) =>
            (unregistered(agent.status) && keepsDrafts) ||
            ((project === undefined || agentInProject(agent, project, personas)) && (owner === undefined || ownedBy(agent, owner))),
    );
};

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
// conversations: a hidden run's steps hide with it and count once, as the run does on the wide board.
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
    const agents = board.fleet.filter((agent) => !shown.has(agent.id) && !insideRun(agent, board.ledger)).length;
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
    const boxFleet = computed<readonly FleetAgent[]>(() => (readingAcross.value ? [...agents.fleet.value, ...otherFleet.value] : agents.fleet.value));
    const scopedFleet = computed(() =>
        scopeFleet(boxFleet.value, { project: projectScope.value, owner: ownerFilter.value, me: host.me.value, personas: personas.value }),
    );
    // Held wakes and runs narrow by the project's evidence alone, since nobody owns them yet.
    const scopedHeld = computed<readonly AutomationApproval[]>(() => {
        const project = projectScope.value;
        return project === undefined
            ? agents.heldWakes.value
            : agents.heldWakes.value.filter((wake) => heldWakeInProject(wake, project, personas.value, boxFleet.value));
    });
    const scopedRuns = computed<readonly WorkflowRun[]>(() => {
        const project = projectScope.value;
        return project === undefined ? host.runs.value : host.runs.value.filter((run) => runInProject(run, project, personas.value, boxFleet.value));
    });
    // An archived run is off the board like an archived agent, in Finished's archive instead.
    const boardRunRows = computed(() => scopedRuns.value.filter((run) => run.archivedAt === undefined));
    // The archive stays the sandbox's: its Delete all empties the whole pile, so its count must say the whole pile.
    const archivedRunRows = computed(() => host.runs.value.filter((run) => run.archivedAt !== undefined));
    const ledgerRunIds = computed(() => runIdsInLedger(host.runs.value));
    const projectHidden = computed(() =>
        hiddenByProject({
            project: projectScope.value,
            fleet: boxFleet.value,
            kept: scopedFleet.value,
            ledger: ledgerRunIds.value,
            runs: host.runs.value,
            keptRuns: boardRunRows.value,
            held: agents.heldWakes.value,
            keptHeld: scopedHeld.value,
        }),
    );
    // The store's own grouping while nothing narrows the board.
    const scopedLanes = computed<Record<FleetLane, FleetAgent[]>>(() =>
        readingAcross.value || projectScope.value !== undefined || ownerFilter.value !== undefined
            ? laneGroups(scopedFleet.value)
            : agents.lanes.value,
    );
    const boardLanes = computed(() => withoutSteps(scopedLanes.value, ledgerRunIds.value));
    watch(host.sharedAccess, (shared) => {
        if (!shared) {
            ownerFilter.value = undefined;
        }
    });
    // The board's own roster, not the sandbox's member list: a colleague with nothing here has nothing to filter to.
    const ownerOptions = computed(() =>
        ownerSegments(host.me.value, boardOwners(boxFleet.value, host.me.value, presenceOthers.value, ownerFilter.value)),
    );
    const ownerScope = computed<string>({
        get: () => ownerFilter.value ?? EVERYONE,
        set: (value) => {
            ownerFilter.value = value === EVERYONE ? undefined : value;
        },
    });
    const scopeOptions = computed(() => [
        { label: t(`shared.thisSandbox`), value: `box` as const },
        { label: t(`agents.agentsView.allSandboxes`), value: `all` as const },
    ]);
    return { scopedHeld, boardRunRows, archivedRunRows, ledgerRunIds, projectHidden, boardLanes, ownerOptions, ownerScope, scopeOptions };
};

// While the board reads across sandboxes: keeps the others live, and says in the Attention lane when some have not
// answered, since an empty lane is otherwise a false claim that nothing needs the reader.
export const followAcross = (): void => {
    followOtherBoxes();
    // A condition, not a strip: true only while it holds, gone the moment it resolves, nothing owed.
    const releaseNotice = hold(`fleet-partial`, () => {
        const partial = partialAnswer.value;
        return partial === undefined
            ? undefined
            : {
                  kind: `condition`,
                  tone: `warning`,
                  title: partial.title,
                  detail: partial.detail,
                  actions: [{ label: t(`ui.action.tryAgain`), severity: `secondary` as const, run: refreshAcross }],
              };
    });
    onUnmounted(releaseNotice);
};
