<!--
    A machine this sandbox already reaches, listed on the card that would give it the door it lacks. It is not a
    connection of this card — desktop sync grants no shell, and nothing here can run a command on it — so the row
    carries no settings, no rename and no remove: only the one step it is missing.
-->
<script setup lang="ts">
import { Button, Row, StatusBadge } from "@intentic/ui";
import type { DeviceConnection } from "../model/deviceConnections";

defineProps<{ device: DeviceConnection }>();
const emit = defineEmits<{ connect: [] }>();
</script>

<template>
    <Row>
        <template #title>
            <span class="flex flex-wrap items-center gap-2">
                <!-- Mono, and the machine's own name: the string its tools and skills are named after. -->
                <span class="truncate font-mono">{{ device.title }}</span>
                <!-- The same word and colour the Devices board gives this machine; one list, read twice. -->
                <StatusBadge size="xs" :dot="true" :variant="device.tone" :label="device.state" />
            </span>
        </template>
        <template #description>
            <!--
                One line that gives way in a deliberate order. The note is the whole reason this row is on this card,
                so it is the part that must survive a narrow column; the detail is what shrinks, and a hostname stays
                recognisable from its head with the rest one hover away.
            -->
            <span class="flex min-w-0 items-baseline gap-1">
                <span v-if="device.detail" class="min-w-0 truncate font-mono text-subtle" :title="device.detail">{{ device.detail }}</span>
                <span v-if="device.detail" class="shrink-0 text-subtle">·</span>
                <span class="shrink-0 text-warning">{{ device.note }}</span>
            </span>
        </template>
        <template #control>
            <Button label="Connect" size="small" :text="true" @click="emit(`connect`)">
                <template #icon><Icon name="desktop" /></template>
            </Button>
        </template>
    </Row>
</template>
