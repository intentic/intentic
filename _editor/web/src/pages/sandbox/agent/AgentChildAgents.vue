<script setup lang="ts">
import type { AdmissionRule } from "@intentic/sandbox-contract";
import { Picker, type PickerOption, Row, RowGroup } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

/* Whether a turn may start agents of its own (the guard's `agents.spawn`), stored in `actionRules`.
 *
 * STILL A PICKER, on a page whose other half became a document, and the difference is worth stating because it
 * looks like an oversight. The safety policy replaced the command rulebook because a REGEX was deciding there,
 * and no arrangement of switches fixes a classifier that cannot tell `echo "rm -rf /"` from a delete. Nothing of
 * the kind is happening here: "may this turn start a child agent" is a fact about the call, not a guess about
 * what a string means, so a switch answers it exactly and a paragraph of prose would only add a way to be
 * misread. When `actionRules` is folded into the policy later, it will be for a different reason.
 *
 * FOUR POSTURES, and Default is one of them because unset is not the same as allow: an unset key holds a spawn
 * from a turn that has taken in outside content, so writing an explicit `allow` switches that off. */
type Posture = "default" | AdmissionRule;

const SPAWN_KEY = `agents.spawn`;

const OPTIONS: readonly PickerOption<Posture>[] = [
    { value: `default`, label: `Default`, icon: `circle`, description: `runs, asks after outside content` },
    { value: `allow`, label: `Always allow`, icon: `check-circle` },
    { value: `hold`, label: `Ask me`, icon: `lock` },
    { value: `deny`, label: `Never`, icon: `times` },
];

const { settings, patch } = useSandboxSettings();

const rules = computed<Readonly<Record<string, AdmissionRule>>>(() => settings.value?.actionRules ?? {});
const posture = computed<Posture>(() => rules.value[SPAWN_KEY] ?? `default`);

// Spread rather than replaced: `actionRules` is an open record that also holds the outbound sniffer's
// `<provider>.<type>` keys, and writing only this one would delete every send rule the owner has.
const setPosture = (next: Posture): void => {
    const actionRules: Record<string, AdmissionRule> = { ...rules.value };
    if (next === `default`) {
        delete actionRules[SPAWN_KEY];
    } else {
        actionRules[SPAWN_KEY] = next;
    }
    patch({ actionRules });
};
</script>

<template>
    <RowGroup label="Helper agents">
        <Row icon="robot" title="Start agents of its own" description="A child agent spends the same connected accounts this one does.">
            <template #control>
                <Picker
                    :model-value="posture"
                    :options="OPTIONS"
                    :disabled="settings === undefined"
                    class="w-36 justify-between text-xs"
                    aria-label="Start agents of its own"
                    header="Start agents of its own"
                    @update:model-value="(next: Posture | undefined) => next !== undefined && setPosture(next)"
                />
            </template>
        </Row>
    </RowGroup>
</template>
