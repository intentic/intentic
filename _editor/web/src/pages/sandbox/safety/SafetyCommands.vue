<script setup lang="ts">
import type { AdmissionRule, CommandClass } from "@intentic/sandbox-contract";
import { Icon, Picker, Row, RowGroup, RowNote, SkeletonRows } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxOutline } from "../../../composables/sandbox/useSandboxOutline";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { COMMAND_RULE_ROWS, type CommandRuleRow, type Posture, postureNote, postureOf, postureOptions, withPosture } from "./commandRules";
import SafetyCommandsInfo from "./SafetyCommandsInfo.vue";

/* THE RULEBOOK, the one control on this page that answers "make it ask before it runs `rm -rf`".
 *
 * Six rows, because the contract has six classes and they are chosen for one property: everything in them is
 * hard or impossible to take back. There is deliberately no row for "everything else" and no way to add one —
 * the gate's own rule is that an unlisted command runs, and a page offering to gate `npm test` would be selling
 * friction as safety. The group's caption says that out loud, because a reader who has just been shown six
 * dangerous things will otherwise read this as a whitelist.
 *
 * A ROW IS A PICKER, NOT A SWITCH, and not a segmented strip either. Three reasons, in the order they bit:
 *
 *   THERE ARE FOUR STATES. `commandRules` stores three verdicts and an ABSENT key, and absence is a real
 *   posture with its own behaviour per class (commandRules.ts argues this at length: it is the difference
 *   between "runs" and "runs unless this turn read a stranger's text"). Four is already past what a switch can
 *   hold, and the fourth is the one every row starts in.
 *
 *   EACH OPTION HAS TO BE TAUGHT. "Ask me" holds the command in a watched turn and REFUSES it in an
 *   automation's; nobody guesses that from two words, and it is the most surprising thing on this page.
 *   <Picker>'s `hint` is built for exactly this ("permission postures, anything where picking wrong is the
 *   expensive move"); a pill has room for the label and nothing else.
 *
 *   SIX ROWS × FOUR PILLS IS NOT A TABLE, it is twenty-four words in a column narrow enough that the last pill
 *   wraps under the first. The closed trigger is one word, so the six line up into the column somebody came
 *   here to read down.
 *
 * WHAT SITS UNDER THE ROW IS THE PAYLOAD. `Default` on two of these classes is a CONDITIONAL hold, and leaving
 * it turns that hold off — an effect with no visible trace anywhere else in the app. The note is warning-toned
 * exactly then and mute otherwise, so this page has one shade of ink meaning "you have given something up" and
 * it appears only where that is true. */

const { settings, patch } = useSandboxSettings();
const outline = useSandboxOutline(computed(() => settings.value === undefined));

const rules = computed<Partial<Readonly<Record<CommandClass, AdmissionRule>>>>(() => settings.value?.commandRules ?? {});

// The rows as the template needs them: each one's stored posture and the line under it resolved once, rather
// than three calls per row in the markup with a non-null assertion on each.
const shown = computed(() =>
    COMMAND_RULE_ROWS.map((row) => {
        const posture = postureOf(rules.value, row.commandClass);
        return { row, posture, note: postureNote(row, posture) };
    }),
);

const setPosture = (row: CommandRuleRow, posture: Posture): void => {
    patch({ commandRules: withPosture(rules.value, row.commandClass, posture) });
};
</script>

<template>
    <RowGroup label="Commands the agent runs" caption="Anything not listed here runs without asking: this names what to stop, not what to permit.">
        <template #info><SafetyCommandsInfo /></template>

        <SkeletonRows v-if="outline" :rows="COMMAND_RULE_ROWS.length" description control />
        <Row v-for="entry in shown" v-else :key="entry.row.commandClass" :icon="entry.row.icon" :title="entry.row.title">
            <!-- The commands themselves, in the type they are written in. The title says what the row MEANS;
                 this says whether it covers the thing the reader came here worried about, which is the question
                 they actually arrived with and which no class name has ever answered. -->
            <template #description>
                <span class="font-mono text-2xs">{{ entry.row.examples }}</span>
            </template>

            <template #control>
                <Picker
                    :model-value="entry.posture"
                    :options="postureOptions(entry.row)"
                    :disabled="settings === undefined"
                    class="w-36 justify-between text-xs"
                    :aria-label="entry.row.title"
                    :header="entry.row.title"
                    @update:model-value="(posture: Posture | undefined) => posture !== undefined && setPosture(entry.row, posture)"
                />
            </template>

            <!-- Inside the row's own hairline rather than in a box of its own: this is the row's current state,
                 not a remark about the group. `items-center` on a glyph beside a wrapping paragraph, never
                 `mt-0.5` — <Row> states that rule for lead icons and states why. -->
            <template v-if="entry.note !== undefined" #below>
                <p class="flex items-center gap-1.5 text-2xs" :class="entry.note.warn ? `text-warning` : `text-subtle`">
                    <Icon :name="entry.note.warn ? `exclamation-triangle` : `info-circle`" aria-hidden="true" class="shrink-0" />
                    <span class="min-w-0">{{ entry.note.text }}</span>
                </p>
            </template>
        </Row>

        <!-- THE HONEST LIMIT, on the surface rather than only behind the (i). The classifier is regex over
             shell text (sandbox-contract's command-classes.ts says so at length), so "Never" on a row is a
             prompt for well-behaved work and not a wall — and the reader most likely to mistake it for one is
             the reader of this page. The real boundaries are structural and elsewhere: the container, the
             isolated worktree, the gate that lands work, an automation's own tool list. -->
        <RowNote icon="info-circle">
            These read the command as text, so a path built from a variable, or a script written in one step and run in the next, goes past them.
            Treat them as a prompt to look rather than as a wall: the container itself is the wall.
        </RowNote>
    </RowGroup>
</template>
