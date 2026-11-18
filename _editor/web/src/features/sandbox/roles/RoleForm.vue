<script setup lang="ts">
import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { SystemPromptMode } from "@intentic/sandbox-contract/schemas/settings";
import type { TurnBriefingNoteId } from "@intentic/sandbox-contract/schemas/roles";
import { BrandMark, Notice, type NoticeModel, SearchBar, SegmentedControl, ui } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, shallowRef } from "vue";
import AddModelButton from "../agent-settings/models/AddModelButton.vue";
import { pinKnobSummary, pinnedList } from "../agent-settings/models/modelPinList";
import ModelPinList from "../agent-settings/models/ModelPinList.vue";
import ModelPinPicker from "../agent-settings/models/ModelPinPicker.vue";
import RoleAccessFields from "./RoleAccessFields.vue";
import RoleBriefingFields from "./RoleBriefingFields.vue";
import RoleKitFields from "./RoleKitFields.vue";
import type { BrowserAccount } from "../../extensions/useBrowserAccounts";
import { useRepos } from "../../../models/workspace/tree/useRepos";
import { formatBytes } from "@intentic/ui/format";
import { useSandboxStorage } from "../overview/storage/useSandboxStorage";
import { useT } from "@intentic/ui/i18n";

// Role editor: one of four questions shown at a time via SegmentedControl, replacing a ~30-control scroll. The draft is
// the parent's, mutated in place. What a role may reach is not on the card: the Access tab shows the access profile
// that holds it (RoleAccessFields), which is kept off the workspace.
const t = useT();

export interface RoleDraft {
    /** The saved role's id; always set, since a role is created before it's edited. */
    original: string;
    label: string;
    capabilities: string[];
    // Workspace-relative; at most one, matching what <FolderPicker> models.
    startIn: string[];
    // Which system prompt a session on this role runs; undefined (the default) follows the sandbox. The TEXT lives in
    // the kit folder (useRoleKit), not here, so the autosave can't rewrite it every keystroke.
    systemPromptMode: SystemPromptMode | undefined;
    // The one-line sentence a new chat is matched on (Role.brief); "" is a role with none, stored as absent.
    brief: string;
    // Which nested repositories its conversations carry (Role.context.repos). undefined means every repository (the
    // default); a list, even empty, is the role deciding, empty means the workspace repository alone.
    carries: string[] | undefined;
    // Which models its conversations run on, in order; empty is stored as absent, so the chat's or job's own pick
    // answers.
    models: ModelPin[];
    // Which of the notes the sandbox prepends to each message this role does without (Role.briefing.omit). Empty is
    // stored as absent: a role that dropped nothing says nothing.
    omitNotes: TurnBriefingNoteId[];
}

const { draft, accounts, connected, error, showRepositories } = defineProps<{
    draft: RoleDraft;
    showRepositories?: boolean;
    /** Logged-in browser profiles, one per account, so a twice-connected site appears twice. */
    accounts: readonly BrowserAccount[];
    /** Which of those are signed in far enough to act. */
    connected: readonly string[];
    error?: NoticeModel;
}>();

// Order follows how someone thinks about a role: who, what it may touch, what it runs on, what it's told. Labels
// match the headings this replaced, so nothing has to be relearned.
const SECTIONS = computed(
    () =>
        [
            { label: t(`sandbox.roleForm.speaks`), value: `identity` },
            { label: t(`sandbox.roleAccess.tab`), value: `access` },
            { label: t(`sandbox.roleForm.runsOn`), value: `runs` },
            { label: t(`sandbox.roleForm.whatTold`), value: `told` },
        ] as const,
);
type Section = (typeof SECTIONS.value)[number][`value`];

// Storage links open the repository controls; other visits start with who the role is.
const section = ref<Section>(showRepositories ? `runs` : `identity`);
const checkoutStorage = useSandboxStorage();
const checkoutCosts = computed(() => new Map((checkoutStorage.report.value?.repositoryCheckouts ?? []).map((repo) => [repo.repo, repo.bytes])));
const largeCheckout = (repo: string): number | undefined => {
    const bytes = checkoutCosts.value.get(repo);
    return bytes !== undefined && bytes >= 1024 ** 3 ? bytes : undefined;
};

// What a chip adds beyond the account's own id: the site only when the id doesn't already say it (avoids "reddit" over
// "Reddit"), and "not signed in" always, since that's never redundant.
const compact = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, ``);
const detailOf = (account: BrowserAccount): string | undefined => {
    const id = compact(account.id);
    const saysSite = compact(account.site).startsWith(id) || id.startsWith(compact(account.platform));
    const parts = [...(saysSite ? [] : [account.site]), ...(connected.includes(account.id) ? [] : [t(`sandbox.roleForm.accountNotSignedIn`)])];
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
// stays visible is the answer (the accounts this role already speaks through), not the full list.
const open = ref(false);
const filter = ref(``);

// Keeps every id the role names, even one with no matching account, so the summary can't quietly drop what the role
// reaches.
const pickedMarks = computed(() => draft.capabilities.map((id) => ({ id, account: accounts.find((entry) => entry.id === id) })));

// Filter only matters once the list outgrows a glance; matches against both id and site.
const query = computed(() => filter.value.trim().toLowerCase());
const shown = computed(() =>
    query.value === ``
        ? accounts
        : accounts.filter((account) => account.id.toLowerCase().includes(query.value) || account.site.toLowerCase().includes(query.value)),
);

// Runs on: one switch for "every repository" (default, stored as nothing), and per-repository toggles under it when
// off. Off means absent from the checkout, not just fenced.
const { nested } = useRepos();
const setCarried = (repo: string, on: boolean): void => {
    const current = draft.carries ?? [];
    draft.carries = on ? [...new Set([...current, repo])] : current.filter((name) => name !== repo);
};

// Same editor Sandbox ▸ Agent ▸ Models uses, over the draft's own list, since the ladder rides the role's autosave like
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
// One picker for the role, over whichever entry raised it; `index` absent means adding (see AgentModels.vue). A second
// press on the trigger that opened it closes it, as on Models.
const editing = shallowRef<{ index: number | undefined; anchor: HTMLElement } | undefined>(undefined);
const openPicker = (index: number | undefined, anchor: HTMLElement): void => {
    editing.value = editing.value?.anchor === anchor ? undefined : { index, anchor };
};
const editingPin = computed<ModelPin | undefined>(() =>
    editing.value?.index === undefined ? undefined : models.entries.value[editing.value.index]?.pin,
);
// While adding, the list ticks the role's own first model, never the chat's.
const editingCurrent = computed<ModelPin | undefined>(() =>
    editing.value !== undefined && editing.value.index === undefined ? models.entries.value[0]?.pin : undefined,
);
const pick = (pin: ModelPin): void => models.apply(editing.value?.index, pin);
const configure = (pin: ModelPin): void => {
    if (editing.value?.index !== undefined) {
        models.apply(editing.value.index, pin);
    }
};
</script>

<template>
    <!-- The form spans the role row; text fields keep their own reading width. -->
    <div class="flex max-w-4xl flex-col gap-6">
        <!-- Tabs under the role's name, one per part of it: as pills they read as one more choice among the form's own. -->
        <SegmentedControl v-model="section" :options="SECTIONS" variant="underline" :aria-label="t(`sandbox.roleForm.whatToChangeAbout`)" />

        <template v-if="section === `identity`">
            <!-- The role's own line, shown first since it's the role saying who it is; also the sentence a new chat is matched on. -->
            <div class="ui-field">
                <label class="ui-field-label" for="role-brief">{{ t(`sandbox.roleForm.what`) }}</label>
                <input
                    id="role-brief"
                    v-model="draft.brief"
                    :class="ui.input('max-w-xl')"
                    maxlength="200"
                    :placeholder="t(`sandbox.roleForm.backendWorkOnApi`)"
                />
                <span class="text-xs text-subtle">{{ t(`sandbox.roleForm.oneLineNewChat`) }}</span>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">{{ t(`sandbox.roleForm.speaksThrough`) }}</span>
                <!-- Stated as a fact about the sandbox, not something missing: a role with no accounts is finished, not half-made. -->
                <p v-if="accounts.length === 0" class="text-xs text-subtle">{{ t(`sandbox.roleForm.noAccountsConnectedIn`) }}</p>
                <template v-else>
                    <!-- Picked accounts are removable chips; choosing happens in the adjacent control. -->
                    <div class="flex flex-wrap items-center gap-1.5">
                        <button
                            v-for="mark in pickedMarks"
                            :key="mark.id"
                            type="button"
                            :class="ui.chip({ on: true, lead: true }, `group hover:border-danger`)"
                            :aria-label="t(`sandbox.roleForm.stopSpeakingThrough`, { id: mark.id })"
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
                        <!-- A role that speaks nowhere is a fine role; the button is the whole state, nothing picked yet. -->
                        <button type="button" :class="ui.textButton({ tone: `quiet` })" :aria-expanded="open" @click="open = !open">
                            <!-- "Add another", not "Change": removing is the chip's own job, this control only adds. -->
                            <Icon :name="open ? `check` : `plus`" class="text-2xs" />
                            {{
                                open
                                    ? t(`sandbox.roleForm.doneChoosing`)
                                    : pickedMarks.length === 0
                                      ? t(`sandbox.roleForm.chooseAccounts`)
                                      : t(`sandbox.roleForm.addAnother`)
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
                            :aria-label="t(`chat.words.filterAccounts2`)"
                            :placeholder="t(`sandbox.roleForm.filterByNameSite`)"
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
                                    picked(account.id) ? `ui-row-select-on border-line` : `border-line hover:border-line-strong hover:bg-card`,
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
                                t(`sandbox.roleForm.noAccountMatches`, { trim: filter.trim() })
                            }}</span>
                        </div>
                    </div>
                </template>
            </div>
        </template>

        <template v-else-if="section === `access`">
            <RoleAccessFields
                :role-id="draft.original"
                :start-in="draft.startIn"
                @update:start-in="(folders: string[]) => (draft.startIn = folders)"
            />
        </template>

        <template v-else-if="section === `runs`">
            <p class="text-xs text-subtle">
                {{ t(`sandbox.roleForm.treeSessionOnRole`) }}
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
                        {{ t(`sandbox.roleForm.whateverChatJobWould`) }}
                    </p>
                    <AddModelButton
                        :label="t(`sandbox.roleForm.addModelRole`)"
                        @open="(anchor: HTMLElement) => openPicker(undefined, anchor)"
                    />
                </div>
            </div>

            <div class="ui-field">
                <span class="ui-field-label">{{ t(`sandbox.roleForm.carries`) }}</span>
                <div class="flex flex-col gap-2">
                    <label class="flex items-center justify-between gap-3">
                        <span class="flex min-w-0 flex-col">
                            <span class="text-sm text-content">{{ t(`sandbox.roleForm.everyRepository`) }}</span>
                            <span class="text-xs text-subtle">{{ t(`sandbox.roleForm.wholeWorkspaceChatNo`) }}</span>
                        </span>
                        <ToggleSwitch
                            class="shrink-0"
                            :model-value="draft.carries === undefined"
                            @update:model-value="(on: boolean) => (draft.carries = on ? undefined : [])"
                        />
                    </label>
                    <template v-if="draft.carries !== undefined">
                        <p v-if="nested.length === 0" class="text-xs text-subtle">
                            {{ t(`sandbox.roleForm.workspaceNoNestedRepositories`) }}
                        </p>
                        <label v-for="repo in nested" :key="repo" class="flex items-center justify-between gap-3 pl-4">
                            <span class="flex min-w-0 flex-col">
                                <span class="truncate text-sm text-content">{{ repo }}</span>
                                <span v-if="largeCheckout(repo) !== undefined" class="text-xs text-warning">{{
                                    t(`sandbox.roleForm.checkoutCost`, { bytes: formatBytes(largeCheckout(repo) ?? 0) })
                                }}</span>
                            </span>
                            <ToggleSwitch
                                class="shrink-0"
                                :model-value="draft.carries.includes(repo)"
                                @update:model-value="(on: boolean) => setCarried(repo, on)"
                            />
                        </label>
                        <!-- An off repository is absent from the session tree. -->
                        <span class="text-xs text-subtle">
                            {{ t(`sandbox.roleForm.repositoryOffNotIn`) }}
                        </span>
                    </template>
                </div>
            </div>

            <ModelPinPicker
                :open="editing !== undefined"
                :anchor="editing?.anchor"
                :pin="editingPin"
                :current="editingCurrent"
                knobs
                :taken="models.taken.value"
                @update:open="editing = undefined"
                @pick="pick"
                @configure="configure"
            />
        </template>

        <!-- The kit section defines the prompt, skills, and briefing. -->
        <template v-else>
            <RoleKitFields
                :role-id="draft.original"
                :mode="draft.systemPromptMode"
                @update:mode="(next: SystemPromptMode | undefined) => (draft.systemPromptMode = next)"
            />
            <RoleBriefingFields :omitted="draft.omitNotes" />
        </template>

        <Notice v-if="error !== undefined" :of="error" />
    </div>
</template>
