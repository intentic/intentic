<script setup lang="ts">
import { fenceCovers, type ModelPin, personaHome, type SystemPromptMode, type TurnBriefingNoteId } from "@intentic/sandbox-contract";
import { BrandMark, ui, Notice, type NoticeModel, SearchBar, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, shallowRef } from "vue";
import AddModelButton from "../agent-settings/models/AddModelButton.vue";
import { pinKnobSummary, pinnedList } from "../agent-settings/models/modelPinList";
import ModelPinList from "../agent-settings/models/ModelPinList.vue";
import ModelPinPicker from "../agent-settings/models/ModelPinPicker.vue";
import FolderPicker from "../devices/FolderPicker.vue";
import { useAreas } from "../areas/useAreas";
import PersonaBriefingFields from "./PersonaBriefingFields.vue";
import PersonaKitFields from "./PersonaKitFields.vue";
import PersonaPowersFields from "./PersonaPowersFields.vue";
import type { BrowserAccount } from "../../extensions/useBrowserAccounts";
import type { PersonaGrantable, PersonaPowersDraft } from "./personaRules";
import { useRepos } from "../../workspace/explorer/useRepos";
import { useT } from "@intentic/ui/i18n";

// Persona editor: one of five questions shown at a time via SegmentedControl, replacing a ~30-control scroll. The folder
// fence lives inside "What it may do", not its own pill, since it's the same question as the toggles above it.
// Permissions stay on one screen so a reader can audit what's off; the draft is the parent's, mutated in place.

// The whole persona as a form. Shelves and per-id grants come from PersonaPowersDraft, shared with the quick panel's
// <PersonaPowersFields>.
const t = useT();

export interface PersonaDraft extends PersonaPowersDraft {
    /** The saved persona's id; always set, since a persona is created before it's edited. */
    original: string;
    label: string;
    capabilities: string[];
    // Both workspace-relative folder lists; `startIn` holds at most one, matching what <FolderPicker> models.
    startIn: string[];
    folders: string[];
    // Which system prompt a session on this persona runs; undefined (the default) follows the sandbox. The TEXT lives in
    // the kit folder (usePersonaKit), not here, so the autosave can't rewrite it every keystroke.
    systemPromptMode: SystemPromptMode | undefined;
    // The one-line sentence a new chat is matched on (Persona.brief); "" is a persona with none, stored as absent.
    brief: string;
    // Which nested repositories its conversations carry (Persona.context.repos). undefined means every repository (the
    // default); a list, even empty, is the persona deciding, empty means the workspace repository alone.
    carries: string[] | undefined;
    // Which models its conversations run on, in order; empty is stored as absent, so the chat's or job's own pick
    // answers.
    models: ModelPin[];
    // Which of the notes the sandbox prepends to each message this persona does without (Persona.briefing.omit). Empty is
    // stored as absent: a persona that dropped nothing says nothing.
    omitNotes: TurnBriefingNoteId[];
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
const SECTIONS = computed(
    () =>
        [
            { label: t(`sandbox.personaForm.speaks`), value: `identity` },
            { label: t(`sandbox.personaForm.whatMayDo`), value: `powers` },
            { label: t(`sandbox.personaForm.runsOn`), value: `runs` },
            { label: t(`sandbox.personaForm.whatTold`), value: `told` },
        ] as const,
);
type Section = (typeof SECTIONS.value)[number][`value`];

// Local, reset on reopen rather than remembered, so a persona always opens on the pill that says who it is.
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

// Who can talk to this persona, read off where it works: a person holds areas, and an area whose folders cover the
// persona's home is what hands it over (policy/persona-home.ts). Nobody picks personas per person, so this line is the only
// place the consequence of a starting folder is visible while it is being chosen.
const { areas } = useAreas();
const reachedBy = computed<string[]>(() => {
    const home = personaHome({
        workspace: { ...(draft.startIn[0] !== undefined ? { startIn: draft.startIn[0] } : {}), folders: draft.folders },
    });
    return areas.value.filter((area) => fenceCovers(area.folders, home)).map((area) => area.label ?? area.id);
});

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
// stays visible is the answer (the accounts this persona already speaks through), not the full list.
const open = ref(false);
const filter = ref(``);

// Keeps every id the persona names, even one with no matching account, so the summary can't quietly drop what the persona
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

// Same editor Sandbox ▸ Agent ▸ Models uses, over the draft's own list, since the ladder rides the persona's autosave like
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
// One picker for the persona, over whichever entry raised it; `index` absent means adding (see AgentModels.vue).
const editing = shallowRef<{ index: number | undefined; anchor: HTMLElement } | undefined>(undefined);
const openPicker = (index: number | undefined, anchor: HTMLElement): void => {
    editing.value = { index, anchor };
};
const editingPin = computed<ModelPin | undefined>(() =>
    editing.value?.index === undefined ? undefined : models.entries.value[editing.value.index]?.pin,
);
const pick = (pin: ModelPin): void => models.apply(editing.value?.index, pin);
const configure = (pin: ModelPin): void => {
    if (editing.value?.index !== undefined) {
        models.apply(editing.value.index, pin);
    }
};
</script>

<template>
    <!-- The form spans the persona row; text fields keep their own reading width. -->
    <div class="flex max-w-4xl flex-col gap-5">
        <!-- Section pills rely on the surrounding field frame. -->
        <SegmentedControl v-model="section" :options="SECTIONS" :aria-label="t(`sandbox.personaForm.whatToChangeAbout`)" />

        <template v-if="section === `identity`">
            <!-- The persona's own line, shown first since it's the persona saying who it is; also the sentence a new chat is matched on. -->
            <div class="ui-field">
                <label class="ui-field-label" for="persona-brief">{{ t(`sandbox.personaForm.what`) }}</label>
                <input
                    id="persona-brief"
                    v-model="draft.brief"
                    :class="ui.input('max-w-xl')"
                    maxlength="200"
                    :placeholder="t(`sandbox.personaForm.backendWorkOnApi`)"
                />
                <span class="text-xs text-subtle">{{ t(`sandbox.personaForm.oneLineNewChat`) }}</span>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">{{ t(`sandbox.personaForm.speaksThrough`) }}</span>
                <!-- Stated as a fact about the sandbox, not something missing: a persona with no accounts is finished, not half-made. -->
                <p v-if="accounts.length === 0" class="text-xs text-subtle">{{ t(`sandbox.personaForm.noAccountsConnectedIn`) }}</p>
                <template v-else>
                    <!-- Picked accounts are removable chips; choosing happens in the adjacent control. -->
                    <div class="flex flex-wrap items-center gap-1.5">
                        <button
                            v-for="mark in pickedMarks"
                            :key="mark.id"
                            type="button"
                            class="ui-chip ui-chip-on group py-1 pl-1.5 pr-2 text-xs hover:border-danger"
                            :aria-label="t(`sandbox.personaForm.stopSpeakingThrough`, { id: mark.id })"
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
                        <!-- A persona that speaks nowhere is a fine persona; the button is the whole state, nothing picked yet. -->
                        <button
                            type="button"
                            :class="ui.linkButton('gap-1 text-xs text-muted hover:text-content')"
                            :aria-expanded="open"
                            @click="open = !open"
                        >
                            <!-- "Add another", not "Change": removing is the chip's own job, this control only adds. -->
                            <Icon :name="open ? `check` : `plus`" class="text-2xs" />
                            {{
                                open
                                    ? t(`sandbox.personaForm.doneChoosing`)
                                    : pickedMarks.length === 0
                                      ? t(`sandbox.personaForm.chooseAccounts`)
                                      : t(`sandbox.personaForm.addAnother`)
                            }}
                        </button>
                    </div>

                    <!-- Capped and scrollable, not as tall as the account list, so a big sandbox doesn't dictate the form's height. -->
                    <div v-if="open" class="mt-1 flex flex-col gap-2 rounded-lg border border-line bg-overlay/50 p-2">
                        <SearchBar
                            v-if="accounts.length > 6"
                            v-model="filter"
                            variant="field"
                            clearable
                            :aria-label="t(`shared.filterAccounts2`)"
                            :placeholder="t(`sandbox.personaForm.filterByNameSite`)"
                        />
                        <!-- Account toggles support multiple picks and show connection state. -->
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
                                <!-- Brand marks retain site colour in both selection states. -->
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
                            <span v-if="shown.length === 0" class="px-1 py-1 text-xs text-subtle">{{
                                t(`sandbox.personaForm.noAccountMatches`, { trim: filter.trim() })
                            }}</span>
                        </div>
                    </div>
                </template>
            </div>
        </template>

        <template v-else-if="section === `powers`">
            <p class="text-xs text-subtle">{{ t(`sandbox.personaForm.everythingOnUnlessTurn`) }}</p>

            <PersonaPowersFields :draft="draft" :grantables="grantables" :folder-bound="folderBound">
                <!-- Folder scope stays in the workspace column with the power toggles. -->
                <template #where="{ rail }">
                    <div class="flex flex-col gap-3">
                        <div class="flex flex-col gap-0.5">
                            <span :class="ui.sectionLabel()">{{ t(`sandbox.personaForm.whereWorks`) }}</span>
                            <!-- The workspace copy is a fact, not a selectable mode. -->
                            <span class="text-xs text-subtle">
                                {{ t(`sandbox.personaForm.everySessionWorksIn`) }}
                            </span>
                        </div>

                        <!-- Folder labels sit above fields so the field gets the full column width. -->
                        <div class="flex flex-col gap-1">
                            <span class="flex items-center gap-2 text-sm text-content">
                                <Icon name="folder-open" :class="rail" />
                                {{ t(`sandbox.personaForm.startsIn`) }}
                            </span>
                            <FolderPicker
                                v-model="draft.startIn"
                                :label="t(`sandbox.personaForm.startsIn`)"
                                :placeholder="t(`sandbox.personaForm.wholeWorkspace`)"
                            />
                            <!-- The consequence of that folder that is not readable from the folder: who gains this
                                 persona by holding the area it sits in. -->
                            <span class="text-2xs text-subtle">{{
                                reachedBy.length === 0
                                    ? t(`sandbox.personaForm.reachedByNobody`)
                                    : t(`sandbox.personaForm.reachedBy`, { areas: reachedBy.join(`, `) })
                            }}</span>
                        </div>

                        <div class="flex flex-col gap-1">
                            <span class="flex items-center gap-2 text-sm text-content">
                                <Icon name="folder" :class="rail" />
                                {{ t(`sandbox.personaForm.onlyFolders`) }}
                            </span>
                            <FolderPicker
                                v-model="draft.folders"
                                multiple
                                :label="t(`sandbox.personaForm.onlyFolders`)"
                                :placeholder="t(`shared.anywhereInWorkspace`)"
                            />
                            <!-- Folder scope rejects file tools outside the selected folders. -->
                            <span class="text-xs text-subtle">
                                {{ t(`sandbox.personaForm.fileToolsPointedOutside`) }}
                            </span>
                        </div>
                    </div>
                </template>
            </PersonaPowersFields>
        </template>

        <template v-else-if="section === `runs`">
            <p class="text-xs text-subtle">
                {{ t(`sandbox.personaForm.treeSessionOnPersona`) }}
            </p>

            <div class="ui-field">
                <span class="ui-field-label">{{ t(`shared.models`) }}</span>
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
                        {{ t(`sandbox.personaForm.whateverChatJobWould`) }}
                    </p>
                    <AddModelButton
                        :label="t(`sandbox.personaForm.addModelPersona`)"
                        @open="(anchor: HTMLElement) => openPicker(undefined, anchor)"
                    />
                </div>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">{{ t(`sandbox.personaForm.carries`) }}</span>
                <div class="flex flex-col gap-2">
                    <label class="flex items-center justify-between gap-3">
                        <span class="flex min-w-0 flex-col">
                            <span class="text-sm text-content">{{ t(`sandbox.personaForm.everyRepository`) }}</span>
                            <span class="text-xs text-subtle">{{ t(`sandbox.personaForm.wholeWorkspaceChatNo`) }}</span>
                        </span>
                        <ToggleSwitch
                            :model-value="draft.carries === undefined"
                            @update:model-value="(on: boolean) => (draft.carries = on ? undefined : [])"
                        />
                    </label>
                    <template v-if="draft.carries !== undefined">
                        <p v-if="nested.length === 0" class="text-xs text-subtle">
                            {{ t(`sandbox.personaForm.workspaceNoNestedRepositories`) }}
                        </p>
                        <label v-for="repo in nested" :key="repo" class="flex items-center justify-between gap-3 pl-4">
                            <span class="truncate text-sm text-content">{{ repo }}</span>
                            <ToggleSwitch :model-value="draft.carries.includes(repo)" @update:model-value="(on: boolean) => setCarried(repo, on)" />
                        </label>
                        <!-- An off repository is absent from the session tree. -->
                        <span class="text-xs text-subtle">
                            {{ t(`sandbox.personaForm.repositoryOffNotIn`) }}
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

        <!-- The kit section defines the prompt, skills, and briefing. -->
        <template v-else>
            <PersonaKitFields
                :persona-id="draft.original"
                :mode="draft.systemPromptMode"
                @update:mode="(next: SystemPromptMode | undefined) => (draft.systemPromptMode = next)"
            />
            <PersonaBriefingFields :omitted="draft.omitNotes" />
        </template>

        <Notice v-if="error !== undefined" :of="error" />
    </div>
</template>
