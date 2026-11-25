import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { computerAgents } from "../../../client/sandbox/useDaemonRoutes";
import { accessBadge, accessKnown, anyProviderReady, nothingShared, providerReady, providerRunnable, withheldBadge } from "../../providers/access";
import { providerWithheld } from "../../providers/aiReach";
import { type ComputerHarness, computerHarness, computerHarnesses, harnessesListed } from "../../providers/computer/computerHarnesses";
import { type ModelOption, providerModels } from "../../providers/providerCatalog";
import { isOlderEntry, lanesOf, offeredProviders, type PickerEntry, type PickerLane, pickerEntries, pickerEntryFor } from "./modelPickerState";

/* WHERE THE MODEL PICKER'S PROVIDERS COME FROM (2026-11-25). In a sandbox they are the vendors it can be connected to, each
   with its catalogue, its price while not connected and its accounts. In a folder window where this computer runs agents
   itself (local/agents/) they are the coding agents installed here, or that could be (Claude Code, Codex), each with the
   models it names itself, and what it needs before it can run: setting up, or its own sign-in. One picker draws either
   (features/chat/models/ModelPicker.vue), and so do the composer's `@` list and `/model`: these are the questions every one
   of them asks of the providers it offers, answered for the side the window is on. Until 2026-11-25 this computer had a
   picker of its own, with no search, no rail and no keyboard, and nothing about it read like a sandbox's. */

export interface PickerSource {
    /** Which side answers: a sandbox's vendors, or this computer's own coding agents. */
    readonly kind: `sandbox` | `computer`;
    /** Every provider offered, in order: the rail's chips and the list's sections. The conversation's own is always among them. */
    readonly offered: (active: AgentProvider) => readonly AgentProvider[];
    /** Those providers in lanes, a lane's label as its header says it. */
    readonly lanes: (providers: readonly AgentProvider[]) => readonly PickerLane[];
    /** Every model row across the offered providers. */
    readonly entries: () => readonly PickerEntry[];
    /** Whether the reader can run a turn on it now: what orders the list, folds it, and dims a rail chip. */
    readonly runnable: (provider: AgentProvider) => boolean;
    /** Whether its rows are locked until something is done for it: connecting it, or setting the coding agent up. */
    readonly locked: (provider: AgentProvider) => boolean;
    /** The chip a lane wears while it cannot run: what it costs, what it still needs, or that it is not the reader's. */
    readonly chip: (provider: AgentProvider) => string | undefined;
    /** A version its family has moved past, which the row says and search sinks. */
    readonly older: (entry: PickerEntry) => boolean;
    /** Known, and nothing at all can run: the way to something that can leads the list. */
    readonly nothingRunnable: () => boolean;
    /** Something is connected and none of it is the reader's: the way on is the owner's grant, never connecting. */
    readonly nothingShared: () => boolean;
}

const sandboxSource: PickerSource = {
    kind: `sandbox`,
    offered: (active) => offeredProviders(active, providerRunnable),
    lanes: lanesOf,
    entries: () => pickerEntries.value,
    runnable: providerRunnable,
    locked: (provider) => !providerReady(provider) && !providerWithheld(provider),
    chip: (provider) => withheldBadge(provider) ?? accessBadge(provider),
    older: isOlderEntry,
    nothingRunnable: () => accessKnown.value && !anyProviderReady() && !nothingShared(),
    nothingShared,
};

// A harness the model route does not answer for keeps its model to itself: one row, sent as no model at all.
const modelsOf = (harness: ComputerHarness): readonly ModelOption[] =>
    harness.asked ? (providerModels.value[harness.id] ?? []) : [{ label: harness.label, value: `` }];

const ready = (provider: AgentProvider): boolean => computerHarness(provider)?.standing === `ready`;

const computerSource: PickerSource = {
    kind: `computer`,
    // The ones that can run first, then the rest, as the listing orders them; the conversation's own even where the
    // listing has dropped it, so its pick is still on the list.
    offered: (active) => {
        const listed = computerHarnesses.value.map((harness) => harness.id);
        return listed.includes(active) || active === `` ? listed : [active, ...listed];
    },
    // A lane per program, named as the program names itself (Claude Code, Codex, Gemini CLI), never as a vendor.
    lanes: (providers) => lanesOf(providers).map((lane) => ({ ...lane, label: computerHarness(lane.providers[0] ?? ``)?.label ?? lane.label })),
    // Only a harness that runs lists rows: one that does not yet has no models to name, and says what it needs instead.
    entries: () =>
        computerHarnesses.value.flatMap((harness) => (harness.standing === `ready` ? modelsOf(harness).map((option) => pickerEntryFor(harness.id, option)) : [])),
    runnable: ready,
    locked: (provider) => !ready(provider),
    chip: (provider) => {
        const standing = computerHarness(provider)?.standing;
        return standing === `setUp` ? t(`chat.computer.picker.notSetUp`) : standing === `signIn` ? t(`chat.computer.picker.signedOut`) : undefined;
    },
    // A harness's model ids are its own aliases (`default`, `opus`, `sonnet[1m]`), with no versions to compare.
    older: () => false,
    nothingRunnable: () => harnessesListed.value && !computerHarnesses.value.some((harness) => harness.standing === `ready`),
    nothingShared: () => false,
};

/** The source for the window's side: this computer's coding agents where it runs them, else the sandbox's providers. */
export const pickerSource = computed<PickerSource>(() => (computerAgents.value ? computerSource : sandboxSource));
