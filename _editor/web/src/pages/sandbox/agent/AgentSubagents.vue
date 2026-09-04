<script setup lang="ts">
import type { AdmissionRule } from "@intentic/sandbox-contract";
import { ui, Picker, Row, RowGroup } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { commitCount } from "./numberInputs";
import { type Posture, postureOf, POSTURES, withPosture } from "./spawnPosture";
import SubagentsInfo from "./SubagentsInfo.vue";

/* HOW MUCH THE ASSISTANT MAY DELEGATE: whether it may at all, and then how far. Four rows on one activity, and
 * they are four rather than one because they stop different things — the posture over the whole feature, the
 * width of one fan-out, the lifetime budget of a conversation, and how far a delegated agent may itself
 * delegate. Raising only the width is what makes a wide sweep hit the second ceiling two rounds later, which
 * reads as the same wall in a new place, so they are shown together.
 *
 * THE POSTURE USED TO BE A GROUP OF ITS OWN, on the Safety tab, called "Child agents". Two things were wrong
 * with that. It filed a delegation ceiling under the gate that decides whether a command may delete your files,
 * which is a different kind of question and a different kind of consequence: nothing about starting an agent is
 * irreversible, it just costs. And it left one concept under two names on two tabs, so an owner who turned the
 * feature down here found the switch that turns it off somewhere else, with nothing on either screen saying they
 * were related. The prompt-injection nuance that put it under Safety survives as a property of the DEFAULT
 * posture, described on the row, rather than as the filing of the whole control.
 *
 * The bounds are the daemon's (SandboxSettingsSchema), restated here so the box refuses a number the save would:
 * a field that accepts 5000 and then silently keeps 200 looks like a setting that didn't take. */
const { settings, patch } = useSandboxSettings();

const AT_ONCE = { min: 1, max: 200 };
const PER_TURN = { min: 1, max: 2000 };
const DEPTH = { min: 1, max: 10 };

/* Whether a turn may start agents of its own (the guard's `agents.spawn`), stored in `actionRules` rather than
 * as a number, because it is the only row here that answers allow/ask/refuse instead of how many. The four
 * postures and the merge the write needs both live in spawnPosture.ts, which says why this is a picker rather
 * than a toggle and why Default is one of the four rather than the absence of a choice. */
const rules = computed<Readonly<Record<string, AdmissionRule>>>(() => settings.value?.actionRules ?? {});
const posture = computed<Posture>(() => postureOf(rules.value));
const setPosture = (next: Posture): void => patch({ actionRules: withPosture(rules.value, next) });

// Whether the three ceilings below bound anything. A refused feature with three live number boxes under it
// invites an owner to tune a limit on work that will never start.
const spawnDenied = computed(() => posture.value === `deny`);
</script>

<template>
    <RowGroup label="Subagents">
        <template #info><SubagentsInfo /></template>

        <!-- WHETHER, before HOW MANY. It leads the group because it is the switch over the other three: reading
             down, the question narrows from "may it delegate" to "how far", which is the order somebody
             arriving with either question can follow. -->
        <Row icon="robot" title="Start agents of its own" description="A child agent spends the same connected accounts this one does.">
            <template #control>
                <Picker
                    :model-value="posture"
                    :options="POSTURES"
                    :disabled="settings === undefined"
                    class="w-36 justify-between text-xs"
                    aria-label="Start agents of its own"
                    header="Start agents of its own"
                    @update:model-value="(next: Posture | undefined) => next !== undefined && setPosture(next)"
                />
            </template>
            <template #below>
                <p v-if="spawnDenied" class="text-2xs text-muted">
                    Delegation is refused outright, so the three limits below bound nothing until this is changed.
                </p>
            </template>
        </Row>

        <!-- The parallel width: the one people meet first, because it is the one a fan-out hits within seconds.
             The assistant is told to stop and NOT retry when it lands here, so the cost of a low number is work
             done one item at a time rather than a failure. -->
        <Row
            icon="users"
            title="Subagents at once"
            description="Maximum delegated agents running in parallel."
        >
            <template #control>
                <input
                    type="number"
                    :min="AT_ONCE.min"
                    :max="AT_ONCE.max"
                    :value="settings?.subagentsAtOnce ?? 20"
                    :disabled="settings === undefined"
                    aria-label="Subagents at once"
                    :class="ui.inputSm('w-20 text-right')"
                    @change="
                        (event: Event) =>
                            commitCount(event, settings?.subagentsAtOnce ?? 20, AT_ONCE, (subagentsAtOnce: number) => patch({ subagentsAtOnce }))
                    "
                />
            </template>
        </Row>

        <!-- The lifetime budget of one conversation. Separate from the width because it is the cap a long session
             creeps up on rather than one a single message hits: twenty rounds of five is the same hundred agents
             as one round of a hundred, and only this row bounds it. -->
        <Row
            icon="clone"
            title="Subagents per conversation"
            description="Total delegated agents allowed per conversation."
        >
            <template #control>
                <input
                    type="number"
                    :min="PER_TURN.min"
                    :max="PER_TURN.max"
                    :value="settings?.subagentsPerTurn ?? 200"
                    :disabled="settings === undefined"
                    aria-label="Subagents per conversation"
                    :class="ui.inputSm('w-20 text-right')"
                    @change="
                        (event: Event) =>
                            commitCount(event, settings?.subagentsPerTurn ?? 200, PER_TURN, (subagentsPerTurn: number) => patch({ subagentsPerTurn }))
                    "
                />
            </template>
        </Row>

        <!-- Nesting. The only one of the three whose runaway case multiplies rather than merely widens, which is
             why the warning below is attached to this row and not to the other two. -->
        <Row
            icon="sitemap"
            title="Nesting depth"
            description="Maximum delegation depth."
        >
            <template #control>
                <input
                    type="number"
                    :min="DEPTH.min"
                    :max="DEPTH.max"
                    :value="settings?.subagentDepth ?? 3"
                    :disabled="settings === undefined"
                    aria-label="Nesting depth"
                    :class="ui.inputSm('w-20 text-right')"
                    @change="
                        (event: Event) => commitCount(event, settings?.subagentDepth ?? 3, DEPTH, (subagentDepth: number) => patch({ subagentDepth }))
                    "
                />
            </template>
        </Row>
    </RowGroup>
</template>
