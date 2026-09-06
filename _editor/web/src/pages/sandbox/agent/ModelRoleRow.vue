<script setup lang="ts">
import type { ModelRoleSpec } from "@intentic/sandbox-contract";
import { type IconName, Row, StatusBadge } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import Checkbox from "primevue/checkbox";
import { computed } from "vue";
import AddModelButton from "./AddModelButton.vue";
import type { PinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";

/* ONE JOB'S ROW on Sandbox ▸ Agent ▸ Models: its name, its mark, whether it is ticked, and the ordered list of
 * models it will try. Eighteen of these are drawn from the catalog, so anything spelled at the call site is
 * spelled eighteen times — which is why this is a component rather than a `v-for` body in the page.
 *
 * ═══ THE MARK AND THE TICK SHARE ONE SLOT ═══
 *
 * They used to sit SIDE BY SIDE, a checkbox and then a glyph, and the pair read as one smudge before the name:
 * two marks in the lead column, an affordance and an identity, each undermining the other. The box stopped
 * looking like something to press because it looked like the first half of a decoration; the glyph stopped
 * saying which job this is because it looked like a second state control. That is what "the icons look weird
 * next to the checkbox" means, and no amount of spacing fixes it — the column is entitled to ONE mark.
 *
 * So the glyph holds that column at rest and BECOMES the tick under the pointer, on keyboard focus, and for as
 * long as the row is selected. One mark, in one place, at one width, so nothing on the row moves as the eye
 * sweeps down the list. It is the swap a file list makes (Drive, Finder, a repo's file tree) and it is made for
 * the same reason: what a row IS and the act of selecting it both want the same 22px.
 *
 * THE TICK IS NEVER MERELY HIDDEN. It is opacity, not `display`, so it keeps its place in the tab order and in
 * the accessibility tree, and `group-focus-within` brings it up the moment it takes focus — a control a pointer
 * alone can reveal is one a keyboard cannot find. A coarse pointer gets it outright, because a tablet at this
 * width has no hover to reveal anything with. Phones drop the column altogether (the page says why), which is
 * why the box is `max-md:hidden` there rather than merely quiet.
 *
 * ═══ THE STATE IS A CHIP, NOT A PARAGRAPH ═══
 *
 * A row with no models used to spend two lines under itself saying so — "Not set: this does not run…" on a
 * one-shot, "Composer default: whatever your chat is set to…" on a run. Both were true, and on a sandbox nobody
 * has configured every one of eighteen rows carried one, which is a page of explanation for a page whose whole
 * content is that no choices have been made yet. The fact is worth a word beside the name; the sentence behind
 * it is worth a tooltip. */

const { role, icon, list, selected, disabled, loaded } = defineProps<{
    role: ModelRoleSpec;
    /* The catalog's glyph. It crosses the wire as an OPEN string, like every other icon this app takes from a
     * declaration, so it is checked rather than asserted and a name this build's icon set does not carry falls
     * back instead of rendering nothing. */
    icon: string;
    list: PinnedList;
    selected: boolean;
    /** The row's controls are inert: settings not read yet, or this job's feature switched off elsewhere. */
    disabled: boolean;
    /* Whether the settings have landed. The chip is a claim about what this job will DO, so it may not be drawn
     * over a record nobody has read yet: "off" that corrects itself a moment later is worse than a beat of
     * silence. */
    loaded: boolean;
}>();

const emit = defineEmits<{ select: [boolean]; open: [number | undefined, HTMLElement] }>();

const glyph = computed<IconName>(() => (isIconName(icon) ? icon : `sparkles`));
const pinned = computed<boolean>(() => list.entries.value.length > 0);

/* THE SWAP, AS TWO CLASS LISTS rather than one reactive flag, because half of it is a question only CSS can
 * answer: nothing in script knows where the pointer is. Written out in full — no interpolation — so Tailwind's
 * scanner finds every one of these classes in this file.
 *
 * The `md:` on the selected states is not decoration either: below it the box is gone, so a row ticked on a
 * desktop and then read on a narrow window would show an empty column instead of its glyph. */
const glyphClass = computed<string>(() =>
    selected ? `md:opacity-0` : `md:group-hover:opacity-0 md:group-focus-within:opacity-0 md:pointer-coarse:opacity-0`,
);
const boxClass = computed<string>(() =>
    selected ? `opacity-100` : `opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:pointer-coarse:opacity-100`,
);

/* WHAT AN EMPTY LIST MEANS, WHICH IS NOT THE SAME FOR THE TWO KINDS OF JOB, and that difference is why the chip
 * carries a word rather than a dash. A one-shot with no models does not happen at all; a whole session with none
 * opens on the model the owner picked for their own chat. Both are legitimate resting states rather than faults,
 * so the chip is neutral: a page of amber over a sandbox nobody has configured would be reporting eighteen
 * problems where there are none. */
const chip = computed<{ readonly label: string; readonly hint: string } | undefined>(() => {
    if (!loaded || pinned.value) {
        return undefined;
    }
    return role.kind === `helper`
        ? { label: `off`, hint: `Not set: this job does not run, and no model is chosen for you. Add a model to switch it on.` }
        : {
              label: `chat default`,
              hint: `Nothing is pinned, so this runs on whatever your chat is set to and keeps following it as you change it. Add a model to pin this job to a tier of its own.`,
          };
});
</script>

<template>
    <!-- THE SPINE FOLLOWS THE CONTENT, and with the empty states gone there are two things left for it to
         follow: a pinned LIST, and the note the one row in eighteen carries. A row with neither draws nothing
         below at all.
         THE NOTE NEEDS IT AS MUCH AS THE LIST DOES, and that is a correction rather than a nicety. `#below` is
         full-width by <Row>'s contract, so with nothing holding a lead column open the note started 34px LEFT
         of the title it belongs to and ran the row's whole width, under the Add button — measured, not
         guessed: 233px against a title column at 267px. It read as the GROUP talking rather than as this row's
         own footnote. The checkbox column used to indent it for free; the mark swap took that column away, so
         the row has to ask for the indent it was getting by accident. -->
    <Row :spine="pinned || $slots[`note`] !== undefined" :description="role.blurb">
        <!-- ONE MARK, TWO STATES. See the header. The box is sized from the tier's own `mark` rather than from a
             number typed here, so the lead stays exactly as wide as every other row's at every density, and the
             tick is centred ON the glyph instead of laid out beside it. -->
        <template #lead="{ mark }">
            <span class="relative flex shrink-0 items-center justify-center" :style="{ width: `${mark}px`, height: `${mark}px` }">
                <Icon :name="glyph" aria-hidden="true" class="text-sm text-subtle transition-opacity" :class="glyphClass" />
                <Checkbox
                    :model-value="selected"
                    binary
                    size="small"
                    class="absolute transition-opacity max-md:hidden"
                    :class="boxClass"
                    :aria-label="`Select ${role.label.toLowerCase()}`"
                    @update:model-value="(value: unknown) => emit(`select`, value === true)"
                />
            </span>
        </template>

        <!-- THE STATE, BESIDE THE NAME. `flex-wrap` because the chip is the first thing entitled to a second
             line: a long job label in a narrow pane may not push its own state off the row.
             THE TWO GAPS DIFFER, AND THE VERTICAL ONE IS THE POINT. At 390px this row's title column measures
             114px — the trailing Add button is 144px and `shrink-0` by <Row>'s contract, so "Commit messages"
             wraps there on its own with no chip at all, and no placement of a chip changes that. What a chip
             MUST not do is read as a heading for the description under it, which is what a wrapped pill sitting
             a full line-gap below the name looks like. Tucked up against the name it stays part of it. -->
        <template #title>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span class="min-w-0">{{ role.label }}</span>
                <StatusBadge v-if="chip !== undefined" v-tooltip.top="chip.hint" variant="neutral" size="xs" :label="chip.label" />
            </span>
        </template>

        <template #control>
            <AddModelButton
                :label="`Add a model for ${role.label.toLowerCase()}`"
                :disabled="disabled"
                @open="(anchor: HTMLElement) => emit(`open`, undefined, anchor)"
            />
        </template>

        <template v-if="pinned || $slots[`note`]" #below>
            <div class="flex flex-col gap-2">
                <!-- Each entry names the tier it will run at beside the model, because that is a property of the
                     entry: press it to change either half. `noteThinking` for the one-shots alone, where reasoning
                     costs latency a job meant to land while you are still looking may not want. -->
                <ModelPinList
                    v-if="pinned"
                    :entries="list.entries.value"
                    :note-thinking="role.kind === `helper`"
                    @promote="list.promote"
                    @remove="list.remove"
                    @edit="(index: number, anchor: HTMLElement) => emit(`open`, index, anchor)"
                />
                <!-- Whatever this particular job owes its reader. One row in eighteen uses it, and a page where
                     every row carried a paragraph is exactly what the chips above just undid — so it stays a slot
                     a caller has to fill on purpose. -->
                <slot name="note" />
            </div>
        </template>
    </Row>
</template>
