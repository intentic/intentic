<script setup lang="ts">
import type { ModelRoleBlock } from "@intentic/sandbox-contract";
import { Row, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import AddModelButton from "./AddModelButton.vue";
import type { PinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";

/* ONE WHOLE GROUP OF JOBS AS A SINGLE ROW on Sandbox ▸ Agent ▸ Models: the Simple view of a block, against
 * <ModelRoleRow>'s Advanced one.
 *
 * WHY A SECOND SHAPE EXISTS AT ALL. The unit of the setting is the ROLE and that is not in question — it is
 * what lets somebody pin Opus to commit subjects without pinning it to every session title. But eighteen jobs
 * is eighteen rows, and the sentence most owners want is "these five, on this, in this order". They can say it
 * through the selection (tick, pick once), and even that is a gesture per visit. Collapsed, the group IS the
 * sentence: one list, one Add button, and the jobs named underneath it.
 *
 * IT IS A VIEW, NOT A SETTING. Nothing is stored per block; a change here writes THE SAME ordered list into
 * every role of the block, one patch, exactly as if it had been typed into each row (see AgentModels' own
 * `groupList`). That is why switching to Advanced can never surprise: what it shows is what this row wrote.
 *
 * WHAT IT DRAWS WHEN THE JOBS DISAGREE, which is the one case a collapsed view can lie about. The list is the
 * INTERSECTION — the entries every job in the block holds — so nothing here claims to be set on a job that
 * does not have it. The chip says so in two words, because a list that silently shows less than the setting
 * holds is the failure mode of every "simple" view ever built. */

const { block, list, differs, disabled, loaded } = defineProps<{
    /** The block being collapsed: its heading names the Add button, its roles are named under the title. */
    block: ModelRoleBlock;
    /** The block's shared list: reads the intersection, writes every role in the block. */
    list: PinnedList;
    /** Whether the block's jobs hold different lists, so this row is showing less than the setting holds. */
    differs: boolean;
    /** Inert while the settings have not been read. */
    disabled: boolean;
    /* Whether the settings have landed. The chip is a claim about what these jobs will DO, so it may not be
     * drawn over a record nobody has read yet — <ModelRoleRow> says why at length. */
    loaded: boolean;
}>();

const emit = defineEmits<{ open: [number | undefined, HTMLElement] }>();

const pinned = computed<boolean>(() => list.entries.value.length > 0);

// What this row is. The count is the point of the view — it is how many jobs one press is about to write — so
// it is in the title rather than in a badge beside the heading, where it used to sit saying nothing.
const title = computed<string>(() => `One list for all ${block.roles.length} jobs`);

// And WHICH jobs, because a row that writes five settings owes their names: the group heading says what they
// have in common, this says what they are.
const jobs = computed<string>(() => block.roles.map((role) => role.label).join(`, `));

/* THE STATE, IN A WORD, and the three it can be. `jobs differ` outranks the other two: while it is true the
 * list on screen is a subset, so "off" (which means no job runs) would be a lie about the jobs holding models
 * of their own. The empty wordings are <ModelRoleRow>'s own, said for a whole block: a one-shot with no models
 * does not run at all, a whole session with none opens on the model the owner picked for their own chat. */
const chip = computed<{ readonly label: string; readonly hint: string } | undefined>(() => {
    if (!loaded) {
        return undefined;
    }
    if (differs) {
        return {
            label: `jobs differ`,
            hint: `These jobs do not all hold the same models. Listed here is what every one of them has; a change made here gives them all exactly this list. Switch to Advanced to see them apart.`,
        };
    }
    if (pinned.value) {
        return undefined;
    }
    return block.id === `helper`
        ? { label: `off`, hint: `Not set: none of these jobs runs, and no model is chosen for you. Add a model to switch them on.` }
        : {
              label: `chat default`,
              hint: `Nothing is pinned, so these run on whatever your chat is set to and keep following it as you change it. Add a model to pin them to a tier of their own.`,
          };
});
</script>

<template>
    <!-- NOT A LABEL AND NOT SELECTABLE, unlike the job rows: there is nothing to tick here — the row IS the
         whole group — so `#below` needs none of their `@click.stop` guarding either. -->
    <Row :spine="pinned" :description="jobs">
        <!-- ITS MARK IS THE SAME BOX THE JOB ROWS DRAW, sized from the tier's own `mark` rather than from a
             number typed here, so the one text column does not step sideways when the view is switched.
             `boxes` is the set's plural glyph — several of the same thing — which is what this row is. -->
        <template #lead="{ mark }">
            <span class="flex shrink-0 items-center justify-center" :style="{ width: `${mark}px`, height: `${mark}px` }">
                <Icon name="boxes" aria-hidden="true" class="text-sm text-subtle" />
            </span>
        </template>

        <template #title>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span class="min-w-0">{{ title }}</span>
                <StatusBadge v-if="chip !== undefined" v-tooltip.top="chip.hint" variant="neutral" size="xs" :label="chip.label" />
            </span>
        </template>

        <template #control>
            <!-- Named for the GROUP, because that is what the press writes: the accessible name is the only
                 thing separating this button from the eighteen the Advanced view offers. -->
            <AddModelButton
                :label="`Add a model for every ${block.label.toLowerCase()} job`"
                :disabled="disabled"
                @open="(anchor: HTMLElement) => emit(`open`, undefined, anchor)"
            />
        </template>

        <template v-if="pinned" #below>
            <!-- The same list the rows draw, with the same four gestures: each one writes the whole order back
                 into every job of the block. `noteThinking` for the one-shots, where reasoning costs latency a
                 job meant to land while you are still looking may not want. -->
            <ModelPinList
                :entries="list.entries.value"
                :note-thinking="block.id === `helper`"
                @promote="list.promote"
                @remove="list.remove"
                @edit="(index: number, anchor: HTMLElement) => emit(`open`, index, anchor)"
            />
        </template>
    </Row>
</template>
