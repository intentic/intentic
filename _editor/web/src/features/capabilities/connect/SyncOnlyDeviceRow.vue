<!-- A machine this sandbox already reaches, listed on the card that would give it the door it lacks. -->
<script setup lang="ts">
import { Button, Row, StatusBadge } from "@intentic/ui";
import type { DeviceConnection } from "../model/deviceConnections";

defineProps<{ device: DeviceConnection }>();
const emit = defineEmits<{ connect: []; disconnect: [] }>();
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
<!-- One line that gives way in a deliberate order. -->
            <span class="flex min-w-0 items-baseline gap-1">
                <span v-if="device.detail" class="min-w-0 truncate font-mono text-subtle" :title="device.detail">{{ device.detail }}</span>
                <span v-if="device.detail" class="shrink-0 text-subtle">·</span>
                <span class="shrink-0 text-warning">{{ device.note }}</span>
            </span>
        </template>
        <template #control>
<!-- Both verbs the row has, since a machine listed under "your connections" the reader cannot end is a dead end: this
             one holds no capability to remove, so ending its desktop sync is the only removal it has. -->
            <span class="flex items-center gap-1">
                <Button label="Disconnect" size="small" :text="true" severity="danger" @click="emit(`disconnect`)">
                    <template #icon><Icon name="times" /></template>
                </Button>
                <Button label="Connect" size="small" :text="true" @click="emit(`connect`)">
                    <template #icon><Icon name="desktop" /></template>
                </Button>
            </span>
        </template>
    </Row>
</template>
