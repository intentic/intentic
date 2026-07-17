<script setup lang="ts">
import { useDevice, useListNavigation } from "@intentic-app/ui";
import { computed, nextTick, onMounted, ref } from "vue";
import { type AgentProvider, PROVIDERS } from "@intentic/sandbox-contract";
import { BADGE_META } from "../composables/chat/catalog";
import { acpProviders, providerAccounts, providerDisplayLabel, providerModelsState } from "../composables/chat/conversation";
import { filterEntries, type PickerEntry, pickerEntries, pickerSections } from "../composables/chat/modelPicker";
import { loadAllProviderModels, loadProviderModels, useChat } from "../composables/chat/useChat";
import ProviderLogo from "./ProviderLogo.vue";

/* The unified model picker (search + provider rail + one grouped list + session-control footer) — width-
 * agnostic so the desktop panel hosts it in a Popover and the mobile panel in a BottomSheet. Rows span every
 * provider: picking one applies provider+harness+model atomically (useChat.selectModel); a mid-chat cross-
 * provider pick just re-points the selection — the fresh session starts lazily at the next send. The rail is
 * a FILTER, never a switcher: it scopes the list without touching the session. Both hosts remount the body
 * per open, so the query/rail reset and the catalogs refresh on every open. */

const emit = defineEmits<{ selected: [] }>();

const { provider, harness, model, thinking, streaming, messages, account, selectAccount, accounts, selectModel } = useChat();
const { mobile } = useDevice();

const query = ref(``);
const rail = ref<AgentProvider | undefined>();
const searchInput = ref<HTMLInputElement | null>(null);

const searching = computed(() => query.value.trim().length > 0);

// The visible list: while searching a single flat ranked section (provider identity rides on every row's
// logo); browsing, one section per provider with the active provider hoisted first. Rows carry their index in
// visual order — the keyboard highlight's coordinate system.
const sections = computed<readonly { provider?: AgentProvider; rows: { entry: PickerEntry; index: number }[] }[]>(() => {
    let index = 0;
    const withRows = (entries: readonly PickerEntry[]): { entry: PickerEntry; index: number }[] =>
        entries.map((entry) => ({ entry, index: index++ }));
    if (searching.value) {
        return [{ rows: withRows(filterEntries(pickerEntries.value, query.value, rail.value)) }];
    }
    return pickerSections(pickerEntries.value, provider.value, rail.value).map((section) => ({
        provider: section.provider,
        rows: withRows(section.entries),
    }));
});
const flat = computed<readonly PickerEntry[]>(() => sections.value.flatMap((section) => section.rows.map((row) => row.entry)));

const { activeIndex, activeRow, move, setRowEl } = useListNavigation(flat, (entry) => entry.key);

// The current selection's row(s): provider+model, and for codex/grok also the harness (claude ignores
// harness — it is always its own loop, so any leftover harness value doesn't distinguish its rows).
const sameScope = (entry: PickerEntry): boolean =>
    entry.provider === provider.value && (entry.provider === `claude` || entry.harness === harness.value);
const isSelected = (entry: PickerEntry): boolean => sameScope(entry) && entry.value === model.value;
// Mid-stream, a model-only swap on the current provider/harness is allowed (today's semantics); anything
// that would switch provider or harness is not.
const isDisabled = (entry: PickerEntry): boolean => streaming.value && !sameScope(entry);

const pick = (entry: PickerEntry): void => {
    if (isDisabled(entry)) {
        return;
    }
    selectModel(entry);
    emit(`selected`);
};

const pickActive = (): void => {
    if (activeRow.value !== undefined) {
        pick(activeRow.value);
    }
};

// Esc clears the query first (restoring the grouped view), then closes. stopPropagation keeps the host
// Popover's own document-level Esc handler from closing it while there's still a query to clear.
const onEsc = (event: KeyboardEvent): void => {
    if (query.value.length > 0) {
        event.stopPropagation();
        query.value = ``;
        return;
    }
    emit(`selected`);
};

// Rail clicks (and the no-results escape) re-point the filter without ending the keyboard flow: focus goes
// straight back to the search input so arrows/Enter/Esc keep working. Mobile keeps its keyboard down.
const railTo = (target: AgentProvider | undefined): void => {
    rail.value = target;
    if (!mobile.value) {
        searchInput.value?.focus();
    }
};

const rowAriaLabel = (entry: PickerEntry): string =>
    `${entry.label}${entry.harness === `claude-code` ? ` via Claude Code` : ``}${isSelected(entry) ? ` — current model` : ``}`;

// The provider rail: the native three plus every installed ACP agent.
const railProviders = computed<readonly { label: string; value: AgentProvider }[]>(() => [
    ...PROVIDERS,
    ...acpProviders.value.map((agent) => ({ label: agent.label, value: agent.id })),
]);

// A provider whose (any) connected account can no longer be refreshed — badge it so a broken credential
// doesn't look identical to a healthy one until the user tries to chat.
const providerNeedsReauth = (target: AgentProvider): boolean => (providerAccounts.value[target] ?? []).some((entry) => entry.needsReauth === true);

const railTooltip = (target: AgentProvider): string =>
    `${providerDisplayLabel(target)}${target === provider.value ? ` · active` : ``}${providerNeedsReauth(target) ? ` · needs reconnect` : ``}`;

// A group whose native catalog hasn't produced rows yet (only the deterministic translator row, if any) gets
// a state row: the codex/grok native lists have no static floor, so pre-load/error would otherwise read as
// "this provider has nothing". Claude's alias floor always renders, so it never qualifies.
const missingNative = (rows: readonly { entry: PickerEntry }[]): boolean => rows.every((row) => row.entry.harness === `claude-code`);
const stateFor = (target: AgentProvider) => providerModelsState.value[target];

// The account the turn will use: the explicit pick, else the first (the daemon's default) — so the picker
// always highlights the one in effect, even before the user touches it.
const activeAccountId = computed(() => account.value ?? accounts.value[0]?.id);

const footerVisible = computed(
    () => accounts.value.length > 1 || provider.value === `claude` || harness.value === `claude-code` || messages.value.length > 0,
);

onMounted(() => {
    // The catalogs are daemon-owned and cached there — refresh on every open so search spans warm lists.
    void loadAllProviderModels();
    // Desktop only: on mobile the software keyboard would instantly cover half the sheet.
    if (!mobile.value) {
        void nextTick(() => searchInput.value?.focus());
    }
});
</script>

<template>
    <div role="combobox" aria-haspopup="listbox" aria-expanded="true" aria-label="Model picker">
        <div class="relative border-b border-line">
            <Icon name="search" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-subtle" aria-hidden="true" />
            <input
                ref="searchInput"
                v-model="query"
                type="text"
                placeholder="Search models…"
                class="w-full min-w-0 bg-transparent py-2.5 pl-9 pr-3 text-base text-content placeholder:text-subtle focus:outline-none md:text-sm"
                role="searchbox"
                aria-controls="model-picker-list"
                :aria-activedescendant="flat.length > 0 ? `model-picker-opt-${activeIndex}` : undefined"
                @keydown.down.prevent="move(1)"
                @keydown.up.prevent="move(-1)"
                @keydown.enter.prevent="pickActive"
                @keydown.esc="onEsc"
            />
        </div>

        <div class="flex max-md:flex-col">
            <!-- Provider rail: a filter, never a switcher — scoping the list to one provider must stay a
                 safe exploratory glance, so switching only ever happens by picking a model row. -->
            <div
                role="radiogroup"
                aria-label="Filter by provider"
                class="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-line py-1.5 max-md:w-full max-md:flex-row max-md:overflow-x-auto max-md:border-b max-md:border-r-0 max-md:px-1.5"
            >
                <button
                    type="button"
                    role="radio"
                    :aria-checked="rail === undefined"
                    class="qopt flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
                    :class="{ 'qopt-on': rail === undefined }"
                    v-tooltip.right="'All providers'"
                    aria-label="All providers"
                    @click="railTo(undefined)"
                >
                    <Icon name="th-large" class="text-sm" :class="rail === undefined ? 'text-primary-500' : 'text-subtle'" />
                </button>
                <div class="mx-auto my-0.5 h-px w-5 shrink-0 bg-line max-md:mx-0.5 max-md:my-auto max-md:h-5 max-md:w-px" aria-hidden="true"></div>
                <button
                    v-for="p in railProviders"
                    :key="p.value"
                    type="button"
                    role="radio"
                    :aria-checked="rail === p.value"
                    class="qopt relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11"
                    :class="{ 'qopt-on': rail === p.value }"
                    v-tooltip.right="railTooltip(p.value)"
                    :aria-label="railTooltip(p.value)"
                    @click="railTo(p.value)"
                >
                    <ProviderLogo :provider="p.value" :class="rail === p.value ? 'text-primary-500' : 'text-subtle'" />
                    <!-- The session-active provider's dot — independent of the filter selection; both must be
                         legible at once. -->
                    <span v-if="p.value === provider" class="absolute right-1 top-1 h-1 w-1 rounded-full bg-primary-500" aria-hidden="true"></span>
                    <Icon
                        v-if="providerNeedsReauth(p.value)"
                        name="exclamation-triangle"
                        class="absolute bottom-0.5 right-0.5 text-[0.5rem] text-warning"
                        aria-hidden="true"
                    />
                </button>
            </div>

            <div id="model-picker-list" class="scrollbar-thin max-h-80 min-w-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Models">
                <template v-for="section in sections" :key="section.provider ?? `search`">
                    <p
                        v-if="section.provider !== undefined"
                        class="flex items-center gap-1.5 px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-subtle"
                        role="presentation"
                    >
                        {{ providerDisplayLabel(section.provider) }}
                        <Icon
                            v-if="providerNeedsReauth(section.provider)"
                            name="exclamation-triangle"
                            class="text-[0.6rem] text-warning"
                            v-tooltip.top="'This account needs to be reconnected'"
                        />
                    </p>
                    <button
                        v-for="row in section.rows"
                        :id="`model-picker-opt-${row.index}`"
                        :key="row.entry.key"
                        :ref="(el) => setRowEl(row.entry.key, el)"
                        type="button"
                        role="option"
                        :aria-selected="row.index === activeIndex"
                        :aria-label="rowAriaLabel(row.entry)"
                        class="mp-row flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40 max-md:min-h-11"
                        :class="{ 'mp-row-on': row.index === activeIndex }"
                        :disabled="isDisabled(row.entry)"
                        @click="pick(row.entry)"
                        @mouseenter="activeIndex = row.index"
                    >
                        <ProviderLogo
                            :provider="row.entry.provider"
                            class="shrink-0 text-sm"
                            :class="isSelected(row.entry) ? 'text-primary-500' : 'text-muted'"
                        />
                        <span class="max-w-[55%] shrink-0 truncate text-sm" :class="isSelected(row.entry) ? 'text-link' : 'text-content'">
                            {{ row.entry.label }}
                        </span>
                        <span v-if="row.entry.harness === `claude-code`" class="shrink-0 text-2xs text-subtle">via Claude Code</span>
                        <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ row.entry.metadata?.description }}</span>
                        <Icon
                            v-for="badge in (row.entry.metadata?.badges ?? []).slice(0, 3)"
                            :key="badge"
                            :name="BADGE_META[badge].icon"
                            class="shrink-0 text-2xs text-subtle"
                            v-tooltip.top="BADGE_META[badge].label"
                        />
                        <Icon v-if="isSelected(row.entry)" name="check" class="shrink-0 text-2xs text-primary-500" aria-hidden="true" />
                    </button>
                    <!-- Native-catalog state row (loading / error+retry) — searching hides it. -->
                    <template v-if="!searching && section.provider !== undefined && missingNative(section.rows)">
                        <div v-if="stateFor(section.provider) === `error`" class="flex items-center gap-2 px-3 py-1.5 text-2xs text-danger">
                            <span>Couldn't load models.</span>
                            <button type="button" class="text-link" @click="void loadProviderModels(section.provider)">Retry</button>
                        </div>
                        <div v-else-if="stateFor(section.provider) === `loaded`" class="px-3 py-1.5 text-2xs text-subtle">No models discovered.</div>
                        <div v-else class="flex items-center gap-2 px-3 py-1.5 text-2xs text-subtle">
                            <Icon name="spinner" spin /> Loading models…
                        </div>
                    </template>
                </template>
                <div v-if="searching && flat.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">
                    <p>No models match.</p>
                    <button v-if="rail !== undefined" type="button" class="mt-1 text-2xs text-link" @click="railTo(undefined)">
                        Search all providers
                    </button>
                </div>
            </div>
        </div>

        <div class="sr-only" aria-live="polite">{{ flat.length }} models</div>

        <!-- Session controls that have no T3Chat analogue: which connected account serves the next turn, the
             harness credential caveat, Claude's extended-thinking knob, and the mid-chat switch hint. -->
        <div v-if="footerVisible" class="flex flex-col gap-2 border-t border-line p-2">
            <template v-if="accounts.length > 1">
                <span class="text-2xs uppercase tracking-wide text-subtle">Account</span>
                <div class="flex flex-col gap-1">
                    <button
                        v-for="a in accounts"
                        :key="a.id"
                        type="button"
                        class="qopt flex h-8 min-w-0 items-center rounded-lg border px-2 text-xs max-md:h-11"
                        :class="{ 'qopt-on': activeAccountId === a.id }"
                        :disabled="streaming"
                        @click="selectAccount(a.id)"
                    >
                        <span class="truncate text-content">{{ a.label }}</span>
                        <Icon
                            v-if="a.needsReauth"
                            name="exclamation-triangle"
                            class="ml-auto shrink-0 text-2xs text-warning"
                            v-tooltip.top="a.detail ?? 'This account needs to be reconnected'"
                        />
                    </button>
                </div>
            </template>

            <p v-if="provider !== `claude` && harness === `claude-code`" class="text-2xs text-subtle">
                Runs this model through the Claude Code harness — set an {{ provider === `codex` ? "OpenAI" : "xAI" }} API key in Sandbox ▸ Agent
                (your subscription sign-in can't be used here).
            </p>

            <!-- Codex reasoning is always on (no toggle); extended thinking is a Claude knob. -->
            <div v-if="provider === `claude`" class="flex items-center justify-between gap-2">
                <span class="text-2xs uppercase tracking-wide text-subtle">Extended thinking</span>
                <button
                    type="button"
                    class="composer-ghost h-7 gap-1 px-2.5 text-xs font-medium max-md:h-10"
                    :class="{ 'composer-active': thinking }"
                    @click="thinking = !thinking"
                    :aria-pressed="thinking"
                    aria-label="Toggle extended thinking"
                >
                    <Icon name="bolt" class="text-2xs" />
                    <span>{{ thinking ? "On" : "Off" }}</span>
                </button>
            </div>

            <!-- A session resumes only on its own runtime, so a mid-chat switch starts a fresh one seeded
                 with the transcript so far (see Conversation.send). -->
            <p v-if="messages.length > 0" class="text-2xs text-subtle">switching starts a fresh session — context carries over</p>
        </div>
    </div>
</template>

<style scoped>
.mp-row {
    cursor: pointer;
    transition: background-color 0.1s;
}
.mp-row:hover {
    background: color-mix(in srgb, var(--color-content) 5%, transparent);
}
.mp-row-on,
.mp-row-on:hover {
    background: color-mix(in srgb, var(--color-primary-500) 15%, transparent);
}
</style>
