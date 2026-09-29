<script setup lang="ts">
import { Picker, Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { rpcQuery } from "../../client/rpcQuery";
import { useSandboxQuery } from "../../client/useSandboxQuery";
import { useRunners } from "../../devices/runners/useRunners";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { HERE, kindDetail, kindTitle, targetOptions, unavailableRunner, withCommandTarget } from "./offloadRows";

// "Where heavy work runs" (settings `offload`): each kind of heavy command an agent runs, either here or on a runner on
// one of your machines. The kinds are the heavy-command rules this sandbox queues by (GET /offload/kinds), so a rule the
// owner adds shows up here too. A runner is added from Devices, per machine.
const t = useT();

const { settings, patch } = useSandboxSettings();
const { query: kindsQuery } = useSandboxQuery(rpcQuery(`offload.kinds`));
const { runners } = useRunners();

const kinds = computed(() => kindsQuery.data.value?.kinds ?? []);
const offload = computed(() => settings.value?.offload ?? { commands: {} });
const options = computed(() => targetOptions(runners.value));
const noRunners = computed(() => runners.value.length === 0);

const setKind = (kind: string, runner: string | undefined): void => {
    if (runner !== undefined) {
        patch({ offload: withCommandTarget(offload.value, kind, runner) });
    }
};
</script>

<template>
    <RowGroup :label="t(`sandbox.agentOffload.title`)">
        <RowNote>
            {{ t(`sandbox.agentOffload.intro`) }}
            <i18n-t v-if="noRunners" keypath="sandbox.agentOffload.noRunners" tag="span" scope="global">
                <template #devices
                    ><RouterLink :to="{ name: `sandbox`, params: { tab: `devices` }, query: {} }" class="underline">{{
                        t(`sandbox.words.devicesSection`)
                    }}</RouterLink></template
                >
            </i18n-t>
        </RowNote>

        <Row v-for="kind in kinds" :key="kind.id" icon="bolt" :title="kindTitle(kind)" :description="kindDetail(kind)">
            <template #control>
                <Picker
                    :model-value="offload.commands[kind.id] ?? HERE"
                    :options="options"
                    :disabled="settings === undefined"
                    class="w-40 justify-between text-xs"
                    :aria-label="kindTitle(kind)"
                    :header="t(`sandbox.agentOffload.runsOn`)"
                    @update:model-value="(next: string | undefined) => setKind(kind.id, next)"
                />
            </template>
            <template v-if="unavailableRunner(offload.commands[kind.id], runners) !== undefined" #below>
                <p class="text-2xs text-muted">{{ unavailableRunner(offload.commands[kind.id], runners) }}</p>
            </template>
        </Row>
    </RowGroup>
</template>
