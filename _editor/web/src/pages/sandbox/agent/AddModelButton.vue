<script setup lang="ts">
import { ui } from "@intentic/ui";

/* THE TRIGGER THAT OPENS THE MODEL PICKER for one of the pinned lists in Sandbox ▸ Agent ▸ Models: three lists,
 * one recipe, so the three controls in that column cannot drift apart.
 *
 * IT WEARS THE FIELD, and the compact size of it (`ui.inputSm`, the 26px tier a row's cluster takes), because it
 * stands where a dropdown used to stand: in a settings row's control column beside real form fields. What it
 * opens is not a dropdown any more but the app's whole model panel, and the caret says "a list opens here"
 * either way. The size is the RECIPE's to state rather than this file's — a call site spelling out padding and
 * type size is the drift the input tiers exist to end (see ui.ts).
 *
 * THE RECIPE DRESSES A BOX AND DOES NOT LAY ONE OUT: it brings the rim, the ground, the control padding and the
 * focus ring, and nothing about the row inside it, which <Picker> composes separately (its `triggerClass`).
 * Without the flex row here the browser's own button centring took over: the label sat in the middle of a 14rem
 * field with the caret glued to its right, reading as a centred pill rather than as the field it stands in for.
 *
 * NARROWER ON A PHONE, because <Row>'s trailing cluster is `shrink-0` by design — a squeezed button is an
 * unclickable one, so the row's own description gives way instead. At 14rem on a 390px screen that description
 * was wrapping to six lines beside a trigger holding three words; 9rem still clears the label and the caret at
 * this type size, and hands the sentence back its width. The panel it opens is a full-width sheet there anyway,
 * so nothing about the choice gets smaller with the trigger.
 *
 * It hands its own element up rather than holding a ref, because that element is what the overlay anchors to,
 * and the picker is owned by the page: one panel at a time, over whichever trigger raised it. */
const emit = defineEmits<{ open: [HTMLElement] }>();
const { label, disabled = false } = defineProps<{ label: string; disabled?: boolean }>();
</script>

<template>
    <button
        type="button"
        :class="
            ui.inputSm(
                `touch-target inline-flex w-56 cursor-pointer select-none items-center gap-2 transition-colors max-md:w-36 disabled:cursor-default`,
            )
        "
        :disabled="disabled"
        :aria-label="label"
        aria-haspopup="listbox"
        @click="emit(`open`, $event.currentTarget as HTMLElement)"
    >
        <span class="min-w-0 flex-1 truncate text-left text-subtle">Add a model…</span>
        <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" aria-hidden="true" />
    </button>
</template>
