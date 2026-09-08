<script setup lang="ts">
import type { ModelPin, SystemPromptMode } from "@intentic/sandbox-contract";
import { BrandMark, ui, Notice, type NoticeModel, SearchBar, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, shallowRef } from "vue";
import AddModelButton from "../agent-settings/models/AddModelButton.vue";
import { pinKnobSummary, pinnedList } from "../agent-settings/models/modelPinList";
import ModelPinList from "../agent-settings/models/ModelPinList.vue";
import ModelPinPicker from "../agent-settings/models/ModelPinPicker.vue";
import FolderPicker from "../devices/FolderPicker.vue";
import PersonaKitFields from "./PersonaKitFields.vue";
import PersonaPowersFields from "./PersonaPowersFields.vue";
import type { BrowserAccount } from "../../extensions/useBrowserAccounts";
import type { PersonaGrantable, PersonaPowersDraft } from "./personaCard";
import { useRepos } from "../../workspace/explorer/useRepos";

// Card editor: one of five questions shown at a time via SegmentedControl, replacing a ~30-control scroll. The folder
// fence lives inside "What it may do", not its own pill, since it's the same question as the toggles above it.
// Permissions stay on one screen so a reader can audit what's off; the draft is the parent's, mutated in place.

// The whole card as a form. Shelves and per-id grants come from PersonaPowersDraft, shared with the quick panel's
// <PersonaPowersFields>.
export interface PersonaDraft extends PersonaPowersDraft {
    /** The saved card's id; always set, since a card is created before it's edited. */
    original: string;
    label: string;
    capabilities: string[];
    // Both workspace-relative folder lists; `startIn` holds at most one, matching what <FolderPicker> models.
    startIn: string[];
    folders: string[];
    // Which system prompt a session on this card runs; undefined (the default) follows the sandbox. The TEXT lives in
    // the kit folder (usePersonaKit), not here, so the autosave can't rewrite it every keystroke.
    systemPromptMode: SystemPromptMode | undefined;
    // The one-line sentence a new chat is matched on (Persona.brief); "" is a card with none, stored as absent.
    brief: string;
    // Which nested repositories its conversations carry (Persona.context.repos). undefined means every repository (the
    // default); a list, even empty, is the card deciding, empty means the workspace repository alone.
    carries: string[] | undefined;
    // Which models its conversations run on, in order; empty is stored as absent, so the chat's or job's own pick
    // answers.
    models: ModelPin[];
}

const { draft, accounts, connected, grantables, error } = defineProps<{
    draft: PersonaDraft;
    /** Logged-in browser profiles, one per account, so a twice-connected site appears twice. */
    accounts: readonly BrowserAccount[];
    /** Which of those are signed in far enough to act. */
    connected: readonly string[];
    /** The connectors, devices and MCP connections this sandbox has, for the per-id grants. */
    grantables: readonly PersonaGrantable[];
    error?: NoticeModel;
}>();

// Order follows how someone thinks about a persona: who, what it may touch, what it runs on, what it's told. Labels
// match the headings this replaced, so nothing has to be relearned.
const SECTIONS = [
    { label: `Speaks as`, value: `identity` },
    { label: `What it may do`, value: `powers` },
    { label: `Runs on`, value: `runs` },
    { label: `What it is told`, value: `told` },
] as const;
type Section = (typeof SECTIONS)[number][`value`];

// Local, reset on reopen rather than remembered, so a card always opens on the pill that says who it is.
const section = ref<Section>(`identity`);

// What a chip adds beyond the account's own id: the site only when the id doesn't already say it (avoids "reddit" over
// "Reddit"), and "not signed in" always, since that's never redundant.
const compact = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, ``);
const detailOf = (account: BrowserAccount): string | undefined => {
    const id = compact(account.id);
    const saysSite = compact(account.site).startsWith(id) || id.startsWith(compact(account.platform));
    const parts = [...(saysSite ? [] : [account.site]), ...(connected.includes(account.id) ? [] : [`not signed in`])];
    return parts.length === 0 ? undefined : parts.join(` · `);
};

const picked = (id: string): boolean => draft.capabilities.includes(id);
const toggleAccount = (id: string): void => {
    const at = draft.capabilities.indexOf(id);
    if (at === -1) {
        draft.capabilities.push(id);
    } else {
        draft.capabilities.splice(at, 1);
    }
};

// Folded away until opened, so a sandbox with many signed-in accounts doesn't push the rest of the form down. What
// stays visible is the answer (the accounts this card already speaks through), not the full list.
const open = ref(false);
const filter = ref(``);

// Keeps every id the card names, even one with no matching account, so the summary can't quietly drop what the persona
// reaches.
const pickedMarks = computed(() => draft.capabilities.map((id) => ({ id, account: accounts.find((entry) => entry.id === id) })));

// Filter only matters once the list outgrows a glance; matches against both id and site.
const query = computed(() => filter.value.trim().toLowerCase());
const shown = computed(() =>
    query.value === ``
        ? accounts
        : accounts.filter((account) => account.id.toLowerCase().includes(query.value) || account.site.toLowerCase().includes(query.value)),
);

// The folder fence is this form's own bound; <PersonaPowersFields>'s caveat needs to know whether it's set.
const folderBound = computed(() => draft.folders.length > 0);

// Runs on: one switch for "every repository" (default, stored as nothing), and per-repository toggles under it when
// off. Off means absent from the checkout, not just fenced.
const { nested } = useRepos();
const setCarried = (repo: string, on: boolean): void => {
    const current = draft.carries ?? [];
    draft.carries = on ? [...new Set([...current, repo])] : current.filter((name) => name !== repo);
};

// Same editor Sandbox ▸ Agent ▸ Models uses, over the draft's own list, since the ladder rides the card's autosave like
// any other field. Knobs on: an entry here says how it runs, not just which model.
const models = pinnedList<ModelPin>({
    read: () => draft.models,
    write: (pins) => {
        draft.models = [...pins];
    },
    decode: (pin) => pin,
    encode: (pin) => pin,
    detail: pinKnobSummary,
    knobs: true,
});
// One picker for the card, over whichever entry raised it; `index` absent means adding (see AgentModels.vue).
const editing = shallowRef<{ index: number | undefined; anchor: HTMLElement } | undefined>(undefined);
const openPicker = (index: number | undefined, anchor: HTMLElement): void => {
    editing.value = { index, anchor };
};
const editingPin = computed<ModelPin | undefined>(() => (editing.value?.index === undefined ? undefined : models.entries.value[editing.value.index]?.pin));
const pick = (pin: ModelPin): void => models.apply(editing.value?.index, pin);
const configure = (pin: ModelPin): void => {
    if (editing.value?.index !== undefined) {
        models.apply(editing.value.index, pin);
    }
};
</script>

<template>
    <!-- As wide as the card's row, not a reading measure, so the powers block has room for two groups side by side; text fields cap their own width. -->
    <div class="flex max-w-4xl flex-col gap-5">
        <!-- Bare pills, no rule under them: the opening row is already bordered, and a second border reads as two controls at one level. -->
        <SegmentedControl v-model="section" :options="SECTIONS" aria-label="What to change about this persona" />

        <template v-if="section === `identity`">
            <!-- The card's own line, shown first since it's the card saying who it is; also the sentence a new chat is matched on. -->
            <div class="ui-field">
                <label class="ui-field-label" for="persona-brief">What it's for</label>
                <input
                    id="persona-brief"
                    v-model="draft.brief"
                    :class="ui.input('max-w-xl')"
                    maxlength="200"
                    placeholder="Backend work on the api and billing services"
                />
                <span class="text-xs text-subtle">One line. A new chat is matched to a persona by this sentence, so say what its work looks like.</span>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">Speaks through</span>
                <!-- Stated as a fact about the sandbox, not something missing: a persona with no accounts is finished, not half-made. -->
                <p v-if="accounts.length === 0" class="text-xs text-subtle">No accounts connected in this sandbox yet.</p>
                <template v-else>
                    <!-- A chip is a picked account; clicking removes it (an ×, not the chooser's tick, since everything here is already picked). -->
                    <div class="flex flex-wrap items-center gap-1.5">
                        <button
                            v-for="mark in pickedMarks"
                            :key="mark.id"
                            type="button"
                            class="ui-chip ui-chip-on group py-1 pl-1.5 pr-2 text-xs hover:border-danger"
                            :aria-label="`Stop speaking through ${mark.id}`"
                            @click="toggleAccount(mark.id)"
                        >
                            <BrandMark
                                :size="16"
                                :name="mark.account?.site ?? mark.id"
                                :logo="mark.account?.logo"
                                :icon="mark.account?.icon ?? `globe`"
                                :idle="!connected.includes(mark.id)"
                            />
                            <span class="truncate font-medium text-content">{{ mark.id }}</span>
                            <Icon name="times" class="shrink-0 text-2xs text-subtle group-hover:text-danger" />
                        </button>
                        <!-- A card that speaks nowhere is a fine card; the button is the whole state, nothing picked yet. -->
                        <button
                            type="button"
                            :class="ui.linkButton('gap-1 text-xs text-muted hover:text-content')"
                            :aria-expanded="open"
                            @click="open = !open"
                        >
                            <!-- "Add another", not "Change": removing is the chip's own job, this control only adds. -->
                            <Icon :name="open ? `check` : `plus`" class="text-2xs" />
                            {{ open ? `Done choosing` : pickedMarks.length === 0 ? `Choose accounts` : `Add another` }}
                        </button>
                    </div>

                    <!-- Capped and scrollable, not as tall as the account list, so a big sandbox doesn't dictate the form's height. -->
                    <div v-if="open" class="mt-1 flex flex-col gap-2 rounded-lg border border-line bg-overlay/50 p-2">
                        <SearchBar
                            v-if="accounts.length > 6"
                            v-model="filter"
                            variant="field"
                            clearable
                            aria-label="Filter accounts"
                            placeholder="Filter by name or site"
                        />
                        <!--
                            Toggles, not a <select>: picking several is normal, and each entry needs a second fact (signed in or not) a select has
                            nowhere to show.
                        -->
                        <div class="flex max-h-44 flex-wrap gap-2 overflow-y-auto">
                            <button
                                v-for="account in shown"
                                :key="account.id"
                                type="button"
                                :aria-pressed="picked(account.id)"
                                :class="[
                                    `group flex cursor-pointer items-center gap-2 rounded-lg border py-1.5 pl-2 pr-2.5 text-left transition-colors`,
                                    picked(account.id) ? `border-link bg-link/10` : `border-line hover:border-line-strong hover:bg-card`,
                                ]"
                                @click="toggleAccount(account.id)"
                            >
                                <!--
                                    Keeps its colour whether picked or not, since colour is how you find the right site in a list; `idle` means
                                    signed out, not unpicked.
                                -->
                                <BrandMark
                                    :size="20"
                                    :name="account.site"
                                    :logo="account.logo"
                                    :icon="account.icon"
                                    :idle="!connected.includes(account.id)"
                                />
                                <!-- Name and detail share one size, told apart by tone rather than a second smaller size. -->
                                <span class="flex min-w-0 items-baseline gap-1.5 text-xs">
                                    <span class="truncate font-medium" :class="picked(account.id) ? `text-content` : `text-muted`">
                                        {{ account.id }}
                                    </span>
                                    <span v-if="detailOf(account) !== undefined" class="truncate text-subtle">{{ detailOf(account) }}</span>
                                </span>
                                <Icon v-if="picked(account.id)" name="check" class="ml-0.5 shrink-0 text-xs text-link" />
                            </button>
                            <span v-if="shown.length === 0" class="px-1 py-1 text-xs text-subtle">No account matches "{{ filter.trim() }}".</span>
                        </div>
                    </div>
                </template>
            </div>
        </template>

        <template v-else-if="section === `powers`">
            <p class="text-xs text-subtle">Everything is on unless you turn it off. A session wearing this card gets exactly what is left.</p>

            <PersonaPowersFields :draft="draft" :grantables="grantables" :folder-bound="folderBound">
                <!--
                    Folder fence rides the workspace column since it's the same question as the toggles above it; lives here, not the shared block,
                    since the quick panel has no pickers.
                -->
                <template #where="{ rail }">
                    <div class="flex flex-col gap-3">
                        <div class="flex flex-col gap-0.5">
                            <span :class="ui.sectionLabel()">Where it works</span>
                            <!--
                                Stated, not asked: this used to be a three-way choice nobody could tell apart, on top of a default every surface
                                already applied.
                            -->
                            <span class="text-xs text-subtle">
                                Every session works in its own copy of the workspace, so several can run at once without touching each other's files.
                            </span>
                        </div>

                        <!--
                            Label sits above, not beside: a folder field needs the column's full width, and a fixed label column would crowd the
                            chips.
                        -->
                        <div class="flex flex-col gap-1">
                            <span class="flex items-center gap-2 text-sm text-content">
                                <Icon name="folder-open" :class="rail" />
                                Starts in
                            </span>
                            <FolderPicker v-model="draft.startIn" label="Starts in" placeholder="The whole workspace" />
                        </div>

                        <div class="flex flex-col gap-1">
                            <span class="flex items-center gap-2 text-sm text-content">
                                <Icon name="folder" :class="rail" />
                                Only these folders
                            </span>
                            <FolderPicker v-model="draft.folders" multiple label="Only these folders" placeholder="Anywhere in the workspace" />
                            <!--
                                Stated here, not just documented: the easiest promise on this field to over-read (it refuses tools, not paths a shell
                                computes).
                            -->
                            <span class="text-xs text-subtle">
                                File tools pointed outside are refused: this stops mistakes and misread instructions, not a shell.
                            </span>
                        </div>
                    </div>
                </template>
            </PersonaPowersFields>
        </template>

        <template v-else-if="section === `runs`">
            <p class="text-xs text-subtle">
                The tree a session wearing this card opens on, and the model that reads it. Both are the same for every session on this card, which is
                what lets a chat matched to it open on a prompt the provider has already cached.
            </p>

            <div class="ui-field">
                <span class="ui-field-label">Models</span>
                <div class="flex flex-col gap-2">
                    <ModelPinList
                        v-if="models.entries.value.length > 0"
                        :entries="models.entries.value"
                        @promote="models.promote"
                        @remove="models.remove"
                        @edit="(index: number, anchor: HTMLElement) => openPicker(index, anchor)"
                    />
                    <!-- Empty is the ordinary state: no ladder here, so the chat's or job's own pick answers instead. -->
                    <p v-else class="text-xs text-subtle">
                        Whatever the chat or the job would have run on anyway. Add a model to decide for every session wearing this card; the
                        first one that answers wins, so a second entry catches an account that is out.
                    </p>
                    <AddModelButton label="Add a model for this persona" @open="(anchor: HTMLElement) => openPicker(undefined, anchor)" />
                </div>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">Carries</span>
                <div class="flex flex-col gap-2">
                    <label class="flex items-center justify-between gap-3">
                        <span class="flex min-w-0 flex-col">
                            <span class="text-sm text-content">Every repository</span>
                            <span class="text-xs text-subtle">The whole workspace, as a chat with no persona sees it.</span>
                        </span>
                        <ToggleSwitch
                            :model-value="draft.carries === undefined"
                            @update:model-value="(on: boolean) => (draft.carries = on ? undefined : [])"
                        />
                    </label>
                    <template v-if="draft.carries !== undefined">
                        <p v-if="nested.length === 0" class="text-xs text-subtle">
                            This workspace has no nested repositories, so the workspace repository is all a session carries either way.
                        </p>
                        <label v-for="repo in nested" :key="repo" class="flex items-center justify-between gap-3 pl-4">
                            <span class="truncate text-sm text-content">{{ repo }}</span>
                            <ToggleSwitch :model-value="draft.carries.includes(repo)" @update:model-value="(on: boolean) => setCarried(repo, on)" />
                        </label>
                        <!-- Stated here, since this switch is easy to under-read: not a fence, the repository simply isn't in the checkout. -->
                        <span class="text-xs text-subtle">
                            A repository that is off is not in the session's tree at all: nothing under it exists there. The workspace repository
                            is always carried.
                        </span>
                    </template>
                </div>
            </div>

            <ModelPinPicker
                :open="editing !== undefined"
                :anchor="editing?.anchor"
                :pin="editingPin"
                knobs
                :taken="models.taken.value"
                @update:open="editing = undefined"
                @pick="pick"
                @configure="configure"
            />
        </template>

        <PersonaKitFields
            v-else
            :persona-id="draft.original"
            :mode="draft.systemPromptMode"
            @update:mode="(next: SystemPromptMode | undefined) => (draft.systemPromptMode = next)"
        />

        <Notice v-if="error !== undefined" :of="error" />
    </div>
</template>
