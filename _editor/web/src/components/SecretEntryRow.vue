<script setup lang="ts">
import type { SecretInventoryEntry } from "@intentic/sandbox-contract";
import { cmp, CopyButton, Notice, type NoticeModel } from "@intentic/ui";
import { computed, ref } from "vue";
import { reveal, useSecrets } from "../composables/secrets/useSecrets";
import { noticeFrom } from "../composables/useAsyncAction";
import SecretField from "./SecretField.vue";

/* One inventory row on the Sandbox Secrets tab, collapsed to a single line: a status dot, the key, and the
 * action cluster (reveal / copy / set-update / remove). Everything secondary — the provenance line,
 * the revealed value, and the in-place editor — lives in a disclosure panel that opens below the row,
 * so the resting height is one line no matter how many secrets there are. Reveal-on-click is the only
 * place a value shows; Copy fetches on demand without revealing; set/update goes through SecretField;
 * remove is a two-step confirm. All state is row-local. */

const props = withDefaults(defineProps<{ entry: SecretInventoryEntry; editable?: boolean; removable?: boolean }>(), {
    editable: false,
    removable: false,
});

const { remove } = useSecrets();

const expanded = ref(false);
const editing = ref(false);
const multiline = ref(false);
const revealedValue = ref<string | undefined>(undefined);
const confirming = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

// A value exists and this viewer is allowed to read it — gates both Reveal and Copy.
const canReveal = computed(() => props.entry.status !== `missing` && props.entry.revealable);
const statusTooltip = computed(() => (props.entry.status === `missing` ? `Not set` : props.entry.status === `connected` ? `Connected` : `Set`));
// What the open panel shows: provenance only, the revealed value, or the editor (reveal ⊕ edit).
const panelMode = computed<`info` | `reveal` | `edit`>(() => (editing.value ? `edit` : revealedValue.value !== undefined ? `reveal` : `info`));

const collapse = (): void => {
    expanded.value = false;
    editing.value = false;
    revealedValue.value = undefined;
    confirming.value = false;
    error.value = undefined;
};

// Chevron / key: open the panel on provenance, or fully collapse it.
const toggle = (): void => {
    if (expanded.value) {
        collapse();
        return;
    }
    expanded.value = true;
};

const toggleReveal = async (): Promise<void> => {
    error.value = undefined;
    if (revealedValue.value !== undefined) {
        revealedValue.value = undefined;
        return;
    }
    editing.value = false;
    expanded.value = true;
    try {
        revealedValue.value = await reveal(props.entry.key);
    } catch (err) {
        error.value = noticeFrom(err, `Could not reveal the value.`);
    }
};

const startEdit = (): void => {
    error.value = undefined;
    revealedValue.value = undefined;
    editing.value = true;
    expanded.value = true;
};

const removeKey = async (): Promise<void> => {
    error.value = undefined;
    try {
        await remove.mutateAsync(props.entry.key);
    } catch (err) {
        confirming.value = false;
        error.value = noticeFrom(err, `Could not remove the secret.`);
    }
};
</script>

<template>
    <div>
        <!-- Collapsed row: one line — status dot, disclosure (chevron + key), then the action cluster. -->
        <div class="flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-canvas">
            <!-- No hover label: the row already prints "Not set" in words next to the key, so the dot is the
                 same fact in a colour and hovering it says the sentence a third time. -->
            <span
                class="h-2 w-2 shrink-0 rounded-full"
                :class="entry.status === `missing` ? `bg-warning` : `bg-success`"
                role="img"
                :aria-label="statusTooltip"
            ></span>

            <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                :aria-expanded="expanded"
                :aria-controls="`secret-${entry.key}-panel`"
                @click="toggle"
            >
                <Icon
                    name="chevron-right"
                    aria-hidden="true"
                    class="shrink-0 text-2xs text-subtle transition-transform"
                    :class="expanded ? `rotate-90` : ``"
                />
                <span v-tooltip.top.overflow="entry.key" class="truncate font-mono text-sm text-content">{{ entry.key }}</span>
                <span
                    v-if="entry.ci !== undefined && !entry.ci.synced"
                    v-tooltip.top="`CI out of date`"
                    class="shrink-0 text-2xs font-medium text-warning"
                    aria-label="CI out of date"
                    >CI</span
                >
                <span v-if="entry.status === `missing`" class="shrink-0 text-2xs italic text-subtle">Not set</span>
            </button>

            <span class="flex shrink-0 items-center gap-0.5 text-subtle">
                <button
                    v-if="entry.status !== `missing`"
                    v-tooltip.top="revealedValue !== undefined ? `Hide` : `Reveal (owner only)`"
                    type="button"
                    class="rounded p-1.5 transition-colors hover:text-content disabled:opacity-40 disabled:hover:text-subtle"
                    :disabled="!canReveal"
                    :aria-label="revealedValue !== undefined ? `Hide value` : `Reveal value (owner only)`"
                    @click="toggleReveal"
                >
                    <Icon :name="revealedValue !== undefined ? `eye-slash` : `eye`" class="text-xs" />
                </button>
                <CopyButton v-if="canReveal" v-tooltip.top="`Copy value`" :text="() => revealedValue ?? reveal(entry.key)" />
                <button
                    v-if="editable"
                    v-tooltip.top="`Set / update`"
                    type="button"
                    class="rounded p-1.5 transition-colors hover:text-content"
                    aria-label="Set / update value"
                    @click="startEdit"
                >
                    <Icon name="pencil" class="text-xs" />
                </button>
                <template v-if="removable">
                    <button
                        v-if="!confirming"
                        v-tooltip.top="`Remove`"
                        type="button"
                        class="rounded p-1.5 transition-colors hover:text-danger"
                        aria-label="Remove"
                        @click="confirming = true"
                    >
                        <Icon name="trash" class="text-xs" />
                    </button>
                    <template v-else>
                        <button
                            v-tooltip.top="`Confirm remove`"
                            type="button"
                            class="rounded p-1.5 text-danger transition-colors hover:bg-danger/10"
                            aria-label="Confirm remove"
                            @click="removeKey"
                        >
                            <Icon name="check" class="text-xs" />
                        </button>
                        <button
                            v-tooltip.top="`Cancel`"
                            type="button"
                            class="rounded p-1.5 transition-colors hover:text-content"
                            aria-label="Cancel remove"
                            @click="confirming = false"
                        >
                            <Icon name="times" class="text-xs" />
                        </button>
                    </template>
                </template>
            </span>
        </div>

        <!-- Disclosure panel: provenance, plus the revealed value or the in-place editor. -->
        <div v-if="expanded" :id="`secret-${entry.key}-panel`" class="border-t border-line py-2.5 pl-8 pr-4">
            <p class="text-2xs text-muted">
                <template v-if="entry.requiredBy.length > 0">
                    Used by <span class="font-mono text-subtle">{{ entry.requiredBy.map((use) => use.resourceId).join(`, `) }}</span> ·
                </template>
                <template v-if="entry.kind === `generated`">generated for you · </template>lives in
                <span class="font-mono text-subtle">{{ entry.storedAt }}</span>
                <template v-if="entry.ci !== undefined"> · CI {{ entry.ci.synced ? `synced` : `out of date` }}</template>
            </p>
            <Notice v-if="error" :of="error" class="mt-2" />

            <div v-if="panelMode === `reveal`" class="mt-2">
                <div class="mb-1 flex items-center gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Value</span>
                    <CopyButton :text="() => revealedValue ?? reveal(entry.key)" label="Copy" />
                </div>
                <code
                    class="block max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-content"
                    >{{ revealedValue }}</code
                >
            </div>

            <div v-else-if="panelMode === `edit`" class="mt-2 flex flex-col gap-1">
                <SecretField
                    :secret-key="entry.key"
                    :capability-id="entry.kind === `capability` ? entry.key : undefined"
                    :multiline="multiline"
                    no-hint
                    cancellable
                    @saved="editing = false"
                    @cancel="editing = false"
                />
                <button type="button" class="self-start text-2xs text-link hover:underline" @click="multiline = !multiline">
                    {{ multiline ? `Single-line value` : `Multi-line value (SSH key, PEM…)` }}
                </button>
            </div>
        </div>
    </div>
</template>
