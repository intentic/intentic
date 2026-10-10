import { isTrialProvider, NATIVE_PROVIDERS, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { sandboxRef } from "@intentic/extension-api";
import { computed, effectScope, type Ref, watch } from "vue";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useRole } from "../../client/sandbox/useRole";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { archived, loadArchived, registry, rosterHeard } from "../agents/fleet/useAgents-registry";
import { acpProviders, endpointProviders } from "../chat/accounts/providerCatalog";
import { refreshConnections } from "../chat/accounts/useChat-accounts";
import { accessKnown, firstReadyProvider, providerReady } from "../chat/session/access";
import { sharedWorkspaceTreeKey } from "../workspace/health/workspaceTreeKey";
import { useGettingStartedChoices } from "./gettingStartedChoices";
import { startAgent } from "../agents/fleet/agentActions";
import { offered, type Progress, progress, type StepFacts, type StepId } from "../tour/steps";
import { trackTour } from "../tour/tourEvents";
import { type MarkStep, wasHinted } from "../tour/tourMarks";
import { publishTour } from "../tour/tourState";

// The getting-started checklist as the editor draws it: the sandbox's own facts (gathered here from reads the editor
// already makes), the reader's choices, and what they come to. One instance per window, started by the first screen
// that asks, so the rail's ring, a page's beacon and the board's slot all read the same answer.

export interface GettingStarted {
    readonly progress: Readonly<Ref<Progress>>;
    // Whether the checklist is on screen at all: offered, or carried on in this window past the land it just saw.
    readonly visible: Readonly<Ref<boolean>>;
    // What the one beacon on screen points at: a step, or the board moment between the first agent and the rest.
    readonly moment: Readonly<Ref<MarkStep | undefined>>;
    // Every step settled in this window: the list says so once, and stays until put away.
    readonly finished: Readonly<Ref<boolean>>;
    // Put away, but still a first run: what the account menu's "show getting started" brings back.
    readonly reopenable: Readonly<Ref<boolean>>;
    readonly hide: () => Promise<void>;
    readonly show: () => Promise<void>;
    readonly skip: (step: StepId) => Promise<void>;
}

// Whether the archive has been asked once, so a sandbox whose every agent was filed away still reads as having had one.
const archiveChecked = sandboxRef(() => false);
// Set when the land is seen to happen in this window while the list was up. A land ends the first run for good (a
// sandbox that arrives already landed never shows the list), but the window that watched it keeps the list until the
// steps left are settled or put away, so the reader is not dropped mid-sentence.
const landedInWindow = sandboxRef(() => false);

let instance: GettingStarted | undefined;

// How long a sandbox counts as new: an agent quiet for longer than this was not started on its first run.
const FIRST_DAYS_MS = 7 * 24 * 60 * 60_000;

const ownModelReady = (): boolean =>
    [...NATIVE_PROVIDERS, ...endpointProviders.value.map((entry) => entry.id), ...acpProviders.value.map((entry) => entry.id)].some(
        (provider) => !isTrialProvider(provider) && providerReady(provider),
    );

const create = (): GettingStarted => {
    const { choices, heard, hide, show, skip } = useGettingStartedChoices();
    const { canShip } = useRole();
    // The shared tree, under the very entry the explorer reads it through, so this asks nothing the workspace does not.
    const { query: tree } = useSandboxQuery({ queryKey: sharedWorkspaceTreeKey(), queryFn: () => sandboxRpc.workspace.tree({}) });

    const landedHere = (): boolean => registry.value.some((agent) => agent.status === `landed` || (agent.landedPresence?.landed ?? 0) > 0);
    const facts = computed<StepFacts>(() => {
        const rosterKnown = rosterHeard.value && (archiveChecked.value || landedHere());
        const filed = archived.value.length > 0;
        return {
            work: tree.data.value === undefined ? undefined : tree.data.value.tree.length > 0,
            // The registry is the daemon's own list, which never holds a draft: any entry is an agent that was sent work.
            agent: rosterKnown ? registry.value.length > 0 || filed : undefined,
            models: accessKnown.value ? ownModelReady() : undefined,
            // Filing a finished agent away is the same trip through review as landing it, so it counts.
            land: rosterKnown ? landedHere() || filed : undefined,
            runnable: accessKnown.value ? firstReadyProvider() !== undefined : undefined,
            ready: registry.value.some((agent) => agent.status === `ready` && agent.archivedAt === undefined),
            established: registry.value.some((agent) => Date.now() - agent.updatedAt > FIRST_DAYS_MS),
        };
    });
    // Until the sandbox has said what this person chose, the list holds still rather than flashing up and away.
    const said = computed(() => (heard.value ? choices.value : { ...choices.value, hidden: true }));
    const isOffered = computed(() => offered(facts.value, said.value, canShip.value));
    const shown = computed(() => progress(facts.value, said.value));
    const carried = computed(() => landedInWindow.value && !choices.value.hidden);
    const visible = computed(() => isOffered.value || carried.value);
    const allSettled = computed(() => shown.value.known && shown.value.settled === shown.value.total);

    watch(
        () => facts.value.land,
        (now, before) => {
            // `before === false` is a land this window saw happen on a first run; a land read in on arrival is `undefined` first.
            if (now === true && before === false && heard.value && !choices.value.hidden && canShip.value) {
                landedInWindow.value = true;
            }
        },
    );
    // A step settling while the list is up is the measure of whether it teaches: each is told once, as it happens.
    watch(
        () => shown.value.rows.map((row) => `${row.id}:${row.state}`).join(`,`),
        (_now, before) => {
            if (before === undefined || !visible.value) {
                return;
            }
            const was = new Map(before.split(`,`).map((pair) => pair.split(`:`) as [string, string]));
            for (const row of shown.value.rows) {
                const previous = was.get(row.id);
                if (row.state === `done` && previous !== undefined && previous !== `done`) {
                    trackTour(`tour_step_done`, { step: row.id });
                }
            }
        },
    );
    // Asked once, and only when it could matter: the roster alone says nothing about agents already filed away.
    watch(
        () => rosterHeard.value && canShip.value && heard.value && !choices.value.hidden && !landedHere() && !archiveChecked.value,
        (ask) => {
            if (ask) {
                void loadArchived().finally(() => {
                    archiveChecked.value = true;
                });
            }
        },
        { immediate: true },
    );
    // The model facts come from the chat's own account read; a screen without a chat on it still needs them.
    watch(
        () => canShip.value && !accessKnown.value,
        (ask) => {
            if (ask) {
                void refreshConnections();
            }
        },
        { immediate: true },
    );

    // The board moment comes between the first agent and whatever is next: once it has started, before the reader has
    // seen the board where it lives. It goes the moment they have (AgentsView marks the visit).
    const moment = computed<MarkStep | undefined>(() => {
        if (!visible.value || allSettled.value) {
            return undefined;
        }
        const agentDone = shown.value.rows.some((row) => row.id === `agent` && row.state === `done`);
        if (agentDone && facts.value.land !== true && facts.value.ready !== true && !wasHinted(`board`, `visited`)) {
            return `board`;
        }
        return shown.value.current;
    });

    const skipStep = async (step: StepId): Promise<void> => {
        trackTour(`tour_step_skipped`, { step });
        await skip(step);
    };
    // What the marks inside the features read (tour/tourState.ts): published once, read live.
    publishTour({
        moment,
        progress: shown,
        visible,
        trial: computed(() => firstReadyProvider() === TRIAL_PROVIDER),
        run: (action) => {
            if (action === `writeTask`) {
                startAgent();
            } else {
                void skipStep(`work`);
            }
        },
    });

    return {
        progress: shown,
        visible,
        moment,
        finished: computed(() => visible.value && allSettled.value),
        reopenable: computed(() => heard.value && choices.value.hidden && offered(facts.value, { ...choices.value, hidden: false }, canShip.value)),
        hide: async () => {
            trackTour(`tour_hidden`, { settled: shown.value.settled, finished: allSettled.value });
            landedInWindow.value = false;
            await hide();
        },
        show,
        skip: skipStep,
    };
};

export const useGettingStarted = (): GettingStarted => {
    // Detached: the reads behind it live as long as the window, not as long as the first screen that drew a beacon.
    instance ??= effectScope(true).run(create);
    if (instance === undefined) {
        throw new Error(`getting started: the detached scope ran nothing`);
    }
    return instance;
};
