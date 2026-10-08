<script setup lang="ts">
import { Button, ContextMenu, Icon } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import type { SwitchMenu } from "../deviceRows";
import { environmentTitle } from "../machineEnvironments";
import type { DeviceOps } from "../runners/deviceOps";

// One of the machine's two switches (file syncing, port mirroring) as a button in the sandbox list's header: the
// half's name and where it stands across the whole PC on the button, the verbs in its menu. Each verb carries, under
// its label, which side it acts on (only on a PC where more than one side keeps folders) and that side's own count, so
// a menu over two sides never reads as "Pause all" twice.

const { menu, ops } = defineProps<{ menu: SwitchMenu; ops: DeviceOps }>();

const sided = computed(() => menu.entries.length > 1);

const items = computed<MenuItem[]>(() =>
    menu.entries.flatMap(({ environment, half }, index) => [
        ...(index > 0 ? [{ separator: true }] : []),
        ...half.actions.map((action): MenuItem => {
            const row: MenuItem = {
                label: action.label,
                icon: action.icon,
                command: () => void ops.runSync(environment, ops.switchKey(environment), undefined, action.command),
            };
            // Only where it tells two sides apart: on one side the button already says where the half stands.
            if (sided.value) {
                row[`hint`] = `${environmentTitle(environment)} · ${half.summary}`;
            }
            return row;
        }),
    ]),
);

// Spins while any side's switch is moving, since that is the press this button made.
const running = computed(() =>
    menu.entries.some(({ environment, half }) => half.actions.some((action) => ops.syncRunning(ops.switchKey(environment), action.command))),
);

const list = ref<{ show: (event: Event) => void } | undefined>();
</script>

<template>
    <Button size="small" tier="quiet" :loading="running" :disabled="ops.working.value" aria-haspopup="menu" @click="list?.show($event)">
        <span class="flex items-center gap-1.5">
            <Icon :name="menu.icon" aria-hidden="true" />
            <span>{{ menu.label }}</span>
            <span :class="menu.settled ? `text-subtle` : `text-warning`">{{ menu.state }}</span>
            <Icon name="chevron-down" class="text-2xs text-subtle" aria-hidden="true" />
        </span>
    </Button>
    <ContextMenu ref="list" :model="items" :min-width="15" />
</template>
