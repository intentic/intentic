<script setup lang="ts">
import { ui } from "@intentic/ui";
import { namesThinking } from "@intentic/sandbox-contract";
import type { DescribedPin } from "../../../composables/chat/modelPins";
import ProviderLogo from "../../../chat/ProviderLogo.vue";

/* AN ORDERED LIST OF PINNED MODELS, numbered in the order they will be tried: the body of all three rows in
 * Sandbox ▸ Agent ▸ Models.
 *
 * It is a component rather than three copies because the parts a copy gets subtly wrong are the parts that
 * matter: the greyed row for an account that has gone away, the promote button disabled at the top, and the
 * numbering, which is the whole reason the list is drawn in full rather than summarised in a 14rem trigger
 * beside it. What a click is about to bill, and which account catches it when that one is spent, are both facts
 * you should be able to read without opening anything.
 *
 * THE ROW IS THE WAY BACK IN. Pressing it opens the app's own model picker over that entry (ModelPinPicker), so
 * the label is a button rather than text: re-pointing a pin at another model, and — for the agent-run list —
 * setting how hard THAT one thinks, both happen where the pin is read. The alternative was what this page used
 * to do, a single effort control beside the whole list, which asked one question of models chosen precisely
 * because they are different.
 *
 * THE ROWS' OWN DIFFERENCES STAY WITH THE ROWS: `warnThinking` for the quick list, where reasoning is a defect,
 * and `detail` for a list whose entries carry run settings worth reading at a glance. What emptying the list
 * falls back to is spelled out by each row's own empty state. */

const { entries, warnThinking = false } = defineProps<{
    // The list AS THE USER WROTE IT, described, not the resolved chain. A pin whose account was disconnected
    // still belongs on screen, greyed, because it is a setting they made. `detail` is what this entry says about
    // HOW it runs (its effort, its harness): absent for the lists whose entries only name a model.
    entries: readonly (DescribedPin & { readonly key: string; readonly index: number; readonly detail?: string | undefined })[];
    // Flag a pin that reasons before it answers. True only for the quick model, where thinking is a defect: the
    // job is meant to be instant. An agent run wants the opposite, so the same badge there would be noise.
    warnThinking?: boolean;
}>();
const emit = defineEmits<{ promote: [number]; remove: [number]; edit: [number, HTMLElement] }>();
</script>

<template>
    <ol class="flex flex-col gap-1">
        <li
            v-for="entry in entries"
            :key="entry.key"
            class="flex items-center gap-2 rounded-md border border-line bg-canvas px-2 py-1 text-xs"
            :class="entry.ready ? `text-content` : `text-subtle`"
        >
            <span class="w-3 shrink-0 text-2xs tabular-nums text-subtle">{{ entry.index + 1 }}</span>
            <!-- The whole naming half of the row is the trigger, so the target is the size of the thing it is
                 about rather than an icon beside it, and it carries the anchor the picker hangs off. -->
            <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 rounded text-left transition-colors hover:text-link"
                :aria-label="`Change ${entry.label}`"
                @click="emit(`edit`, entry.index, $event.currentTarget as HTMLElement)"
            >
                <ProviderLogo v-if="entry.choice" :provider="entry.choice.provider" class="shrink-0 text-xs text-muted" />
                <span class="min-w-0 flex-1 truncate" v-tooltip.top.overflow="entry.label">{{ entry.label }}</span>
                <!-- What this entry says about how it runs: its reasoning tier, its harness, the speed it asks
                     for. Only the list whose pins carry those passes it, and only the fields actually set are
                     named, so a pin left at the provider's defaults adds nothing to read. -->
                <span v-if="entry.detail" class="shrink-0 text-2xs text-subtle">{{ entry.detail }}</span>
            </button>
            <!-- A pin whose account is gone stays on the list and says so. The resolver skips it at run time, so
                 the feature keeps working, but silently dropping it from the screen would look like the app had
                 eaten a setting the user made. -->
            <span v-if="!entry.ready" class="shrink-0 text-2xs text-warning">Not connected</span>
            <!-- …and a quick-model pin that will THINK says so too, because nothing else on this screen would.
                 A routed channel publishes one row per reasoning level and spells the level into the id, so
                 `…-flash-high` and `…-flash-low` sit in the picker looking like two ordinary models, and
                 picking the wrong one turns a two-second commit message into a half-minute one. Auto is kept off
                 these rows by the ordering itself (contract model-order.ts); a pin is a deliberate choice and is
                 run as written, so the only thing owed here is that the choice be legible after it is made. -->
            <span
                v-else-if="warnThinking && entry.choice && namesThinking(entry.choice.model)"
                class="shrink-0 text-2xs text-warning"
                v-tooltip.top="
                    'This model reasons before it answers: accurate, but seconds slower for a job meant to be instant. A quieter row of the same model is usually the better quick model.'
                "
            >
                Thinks
            </span>
            <button
                type="button"
                :class="ui.iconButton(`h-auto w-auto shrink-0 rounded p-1 text-subtle`)"
                :disabled="entry.index === 0"
                @click="emit(`promote`, entry.index)"
                v-tooltip.top="'Try this one earlier'"
                :aria-label="`Move ${entry.label} earlier`"
            >
                <Icon name="chevron-up" class="text-2xs" />
            </button>
            <button
                type="button"
                class="shrink-0 rounded p-1 text-subtle transition-colors hover:bg-overlay hover:text-danger"
                @click="emit(`remove`, entry.index)"
                v-tooltip.top="'Remove from the order'"
                :aria-label="`Remove ${entry.label}`"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </li>
    </ol>
</template>
