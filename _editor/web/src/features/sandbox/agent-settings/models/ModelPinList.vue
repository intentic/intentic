<script setup lang="ts">
import { ui } from "@intentic/ui";
import { namesThinking } from "@intentic/sandbox-contract";
import type { DescribedPin } from "../../../chat/models/modelPins";
import ProviderLogo from "../../../chat/accounts/ProviderLogo.vue";

/* AN ORDERED LIST OF PINNED MODELS, numbered in the order they will be tried: the body of every role's row in
 * Sandbox ▸ Agent ▸ Models.
 *
 * It is a component rather than a copy per row because the parts a copy gets subtly wrong are the parts that
 * matter: the greyed row for an account that has gone away, the promote button disabled at the top, and the
 * numbering, which is the whole reason the list is drawn in full rather than summarised in a 14rem trigger
 * beside it. What a click is about to bill, and which account catches it when that one is spent, are both facts
 * you should be able to read without opening anything. There are seventeen of these rows now, one per job, so
 * the argument for one component is seventeen times what it was.
 *
 * THE ROW IS THE WAY BACK IN. Pressing it opens the app's own model picker over that entry (ModelPinPicker), so
 * the label is a button rather than text: re-pointing a pin at another model, and setting how hard THAT one
 * thinks, both happen where the pin is read. The alternative was what this page used to do, a single effort
 * control beside the whole list, which asked one question of models chosen precisely because they are different.
 *
 * WHAT DIFFERS PER ROW STAYS WITH THE ROW: `noteThinking` for the one-shot jobs, where reasoning costs latency
 * a job meant to be instant may not want, and `detail` for what an entry says about how it runs. What emptying
 * the list falls back to is spelled out by each row's own empty state. */

const { entries, noteThinking = false } = defineProps<{
    // The list AS THE USER WROTE IT, described, not the resolved chain. A pin whose account was disconnected
    // still belongs on screen, greyed, because it is a setting they made. `detail` is what this entry says about
    // HOW it runs (its effort, its harness): absent for the lists whose entries only name a model.
    entries: readonly (DescribedPin & { readonly key: string; readonly index: number; readonly detail?: string | undefined })[];
    // Note a pin that reasons before it answers. True for the one-shot helper jobs, where it is a real cost
    // worth seeing: those are meant to land while you are still looking. A whole session wants the opposite, so
    // the same badge there would be noise.
    noteThinking?: boolean;
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
                <!-- A FLOOR UNDER THE NAME, and it is the whole reason this row does not read as `C·` in a narrow
                     column. Both halves truncate, but a `flex-1` name has a zero basis and so gives up its width
                     FIRST: with all four knobs pinned ("Max · thinking · fast · Claude Code") the detail is longer
                     than the model it describes, and at a phone's width it took every pixel and left two
                     characters of the thing the row exists to name. The floor makes the detail yield instead. -->
                <span class="min-w-[6rem] flex-1 truncate" v-tooltip.top.overflow="entry.label">{{ entry.label }}</span>
                <!-- What this entry says about how it runs: its reasoning tier, its harness, the speed it asks
                     for. Only the fields actually set are named, so a pin left at the provider's defaults adds
                     nothing to read. It truncates rather than pushing, and carries its own tooltip for the same
                     reason the name does: cut short, it is still the only place the knobs are legible. -->
                <span v-if="entry.detail" class="min-w-0 shrink truncate text-2xs text-subtle" v-tooltip.top.overflow="entry.detail">{{
                    entry.detail
                }}</span>
            </button>
            <!-- A pin whose account is gone stays on the list and says so. The resolver skips it at run time, so
                 the feature keeps working, but silently dropping it from the screen would look like the app had
                 eaten a setting the user made. -->
            <span v-if="!entry.ready" class="shrink-0 text-2xs text-warning">Not connected</span>
            <!-- …and a one-shot pin that will THINK says so too, because nothing else on this screen would.
                 A routed channel publishes one row per reasoning level and spells the level into the id, so
                 `…-flash-high` and `…-flash-low` sit in the picker looking like two ordinary models, and picking
                 one without meaning to turns a two-second commit message into a half-minute one.

                 A NOTE, NOT A WARNING, and the tone follows: the daemon now runs these pins as written, thinking
                 included (claude-one-shot.ts), so a reasoning model here is a thing an owner can legitimately
                 want rather than a mistake to flag. What is owed is that the cost be legible after the choice,
                 not that the choice be argued with. -->
            <span
                v-else-if="noteThinking && entry.choice && namesThinking(entry.choice.model)"
                class="shrink-0 text-2xs text-subtle"
                v-tooltip.top="
                    'This model reasons before it answers: better judgement, and seconds slower on a job that usually lands while you are still looking at it. Run as written.'
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
