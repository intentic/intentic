<script setup lang="ts">
import type { AdmissionRule, CommandClass } from "@intentic/sandbox-contract";
import { Picker, Row, RowGroup, SkeletonRows } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxOutline } from "../../../composables/sandbox/useSandboxOutline";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { COMMAND_RULE_ROWS, type CommandRuleRow, type Posture, postureOf, postureOptions, withPosture } from "./commandRules";

/* Six kinds of hard-to-undo shell command, one verdict each. Anything not listed runs: the gate names what to
 * stop, not what to permit.
 *
 * A <Picker> rather than pills because there are FOUR states (commandRules.ts says why Default is one of them)
 * and its closed trigger is one word, so six rows line up into a column that can be read down. */

const { settings, patch } = useSandboxSettings();
const outline = useSandboxOutline(computed(() => settings.value === undefined));

const rules = computed<Partial<Readonly<Record<CommandClass, AdmissionRule>>>>(() => settings.value?.commandRules ?? {});

const setPosture = (row: CommandRuleRow, posture: Posture): void => {
    patch({ commandRules: withPosture(rules.value, row.commandClass, posture) });
};
</script>

<template>
    <RowGroup label="Commands the agent runs">
        <SkeletonRows v-if="outline" :rows="COMMAND_RULE_ROWS.length" description control />
        <Row v-for="row in COMMAND_RULE_ROWS" v-else :key="row.commandClass" :icon="row.icon" :title="row.title">
            <template #description>
                <span class="font-mono text-2xs">{{ row.examples }}</span>
            </template>
            <template #control>
                <Picker
                    :model-value="postureOf(rules, row.commandClass)"
                    :options="postureOptions(row)"
                    :disabled="settings === undefined"
                    class="w-36 justify-between text-xs"
                    :aria-label="row.title"
                    :header="row.title"
                    @update:model-value="(posture: Posture | undefined) => posture !== undefined && setPosture(row, posture)"
                />
            </template>
        </Row>
    </RowGroup>
</template>
