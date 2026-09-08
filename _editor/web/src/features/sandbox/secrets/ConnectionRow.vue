<script setup lang="ts">
import { Row } from "@intentic/ui";
import { nextTick, ref, useTemplateRef } from "vue";
import UsageRing from "../../../components/UsageRing.vue";
import type { PlanHeadroom } from "../../chat/session/usageStatus";

// One row for every credential the Agent tab shows (native account, subscription, empty and add placeholders),
// all answering the same question: what am I signed in with, what can I do about it. Fixed anatomy: glyph, editable
// name, state text, one action, an in-row sign-in panel below. `state` drives only the glyph and tone, never the
// layout.

const {
    title,
    state,
    activity,
    headroom,
    interactive = false,
} = defineProps<{
    title: string;
    // `unknown` is the honest first frame: the daemon hasn't answered, so the dot must not claim either way.
    state: `connected` | `reauth` | `missing` | `unknown` | `add`;
    // The state line beside the title (the signed-in identity, "not connected", "signing in...").
    note?: string;
    // Whether `note` is a live wait, which earns it a spinner: the one moving thing in the row.
    noteBusy?: boolean;
    // The half-sentence under the title: what this connection costs, what it runs, or why it needs reconnecting.
    description?: string;
    // Description not loaded yet; shows a placeholder bar so a later-arriving line doesn't shift rows below it.
    descriptionPending?: boolean;
    tone?: `default` | `warning`;
    interactive?: boolean;
    // Whether this connection's name is the user's to change: true only where the sandbox owns the credential.
    renamable?: boolean;
    // Plan-limit headroom once read; replaces the dot with a ring. Undefined keeps the plain dot.
    headroom?: PlanHeadroom;
    // Spend on this connection, shown in the ring's card, not the row; omitted with no ring (Cursor, Grok).
    activity?: string;
    // Whether this account is exhausted (>=90% utilization). Dims the row so active accounts stand out.
    exhausted?: boolean;
}>();

const emit = defineEmits<{ rename: [label: string] }>();

// In-place renaming: commits on Enter or blur (no Save button), Escape restores the original. A value equal to
// the current title emits nothing, so an accidental click through the name is free.
const editing = ref(false);
const draft = ref(``);
const input = useTemplateRef<HTMLInputElement>(`nameInput`);

const startEditing = (): void => {
    draft.value = title;
    editing.value = true;
    void nextTick(() => input.value?.select());
};

const commit = (): void => {
    if (!editing.value) {
        return;
    }
    editing.value = false;
    if (draft.value.trim() !== title) {
        emit(`rename`, draft.value.trim());
    }
};

const cancel = (): void => {
    editing.value = false;
};

const DOT_TONE: Record<string, string> = {
    connected: `bg-success`,
    reauth: `bg-warning`,
    missing: `bg-content/25`,
    // Pulsing: not a verdict, something is still being read.
    unknown: `bg-content/25`,
};
</script>

<template>
    <Row :interactive="interactive" :class="[tone === `warning` ? `bg-warning/10` : ``, exhausted ? `opacity-50` : ``]">
        <template #title>
            <!-- Wraps, not truncates: the connection kind stays first so a Grok subscription row can't read as native. -->
            <span class="flex min-w-0 flex-wrap items-center gap-x-2.5" :class="state === `add` ? `text-muted` : ``">
                <span class="flex w-[1.125rem] shrink-0 justify-center">
                    <Icon v-if="state === `add`" name="plus" class="text-2xs" />
                    <!--
                        Ring replaces the dot when headroom is known, using the same green/yellow/red system. Its hover card spills
                        left into the gutter, keeping the row's name/state/buttons to the right clear.
                    -->
                    <UsageRing v-else-if="headroom" :headroom="headroom" :activity="activity" flank="left" />
                    <span v-else class="h-1.5 w-1.5 rounded-full" :class="DOT_TONE[state]" />
                </span>
                <!-- `w-44`, not full width: an input spanning the row would read as a search box. -->
                <input
                    v-if="editing"
                    ref="nameInput"
                    v-model="draft"
                    name="connectionName"
                    class="ui-field-box ui-field-inline w-44 min-w-0 px-1.5 py-0.5 text-sm font-semibold"
                    :aria-label="`Rename ${title}`"
                    @keydown.enter="commit"
                    @keydown.esc="cancel"
                    @blur="commit"
                />
                <!--
                    Pencil stays visible at half opacity (hover-only is undiscoverable on touch); the "Rename" tooltip rides the
                    pencil, not the name, so hovering the name still offers the overflow tooltip instead.
                -->
                <button
                    v-else-if="renamable"
                    type="button"
                    class="group/name flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
                    @click="startEditing"
                >
                    <span class="min-w-0 truncate" v-tooltip.overflow="title">{{ title }}</span>
                    <Icon
                        name="pencil"
                        class="shrink-0 text-2xs text-subtle opacity-50 transition-opacity group-hover/name:opacity-100"
                        v-tooltip.top="`Rename`"
                    />
                </button>
                <span v-else class="min-w-0 truncate" v-tooltip.overflow="title">{{ title }}</span>
                <span v-if="note && !editing" class="flex items-center gap-1 text-2xs font-normal text-subtle">
                    <Icon v-if="noteBusy" name="spinner" spin />{{ note }}
                </span>
            </span>
        </template>
        <!--
            Indented to the title's x, not the glyph's. A placeholder bar holds the line's height while its read is still
            out, so the row is full height from the first frame.
        -->
        <template v-if="description || descriptionPending" #description>
            <span v-if="descriptionPending" class="flex min-h-[1lh] items-center pl-7" aria-hidden="true">
                <span class="skeleton block h-2.5 w-56" />
            </span>
            <span v-else class="block pl-7" :class="tone === `warning` ? `text-warning` : ``">{{ description }}</span>
        </template>
        <template v-if="$slots[`control`]" #control><slot name="control" /></template>
        <template v-if="$slots[`below`]" #below><slot name="below" /></template>
    </Row>
</template>
