<!-- THE PHONE'S SANDBOXES, along the foot of the board once there is more than one to go to: one logo each, in the reader's
     own order (sandboxOrder.ts), where the thumb rests. The one open now is its own tile, plated (PhoneSandboxTile.vue,
     the way to the Menu page), so the rail above starts with the sections instead of repeating it; a press on any other
     switches to it. Each carries what waits for its reader there (Home's own count, useHomeAttention), and one whose
     machine does not answer is drawn faded, as on Home. With one sandbox there is nothing to switch to and no bar: its
     logo stays atop the rail (MobileRail.vue). -->
<script setup lang="ts">
import { SandboxLogo } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useHomeAttention } from "../../../models/home/useHomeAttention";
import { arrangedSandboxes } from "../../../models/home/sandboxOrder";
import ViewBadgeChip from "../../../workbench/views/ViewBadgeChip.vue";
import { phoneRailFrame } from "../railFrame";
import PhoneSandboxTile from "./PhoneSandboxTile.vue";

const t = useT();
const sandbox = useSandbox();
// The switchable ones (roster.ts), in the reader's order, as the Menu page lists them.
const boxes = computed(() => arrangedSandboxes(sandbox.sandboxes.value));
// At the across-sandboxes store's ambient pace, and never the box the shell is in: its own tiles count that one.
const readings = useHomeAttention({ everyMs: 45_000, skip: () => sandbox.activeSandboxId.value });
const waitingFor = (id: string): number => readings.value.get(id)?.needsYou ?? 0;
const unreachable = (id: string): boolean => readings.value.get(id)?.unreachable === true;
const labelOf = (id: string, name: string): string => {
    const count = waitingFor(id);
    return count > 0 ? `${name} · ${t(`home.otherSandboxes.needing`, { count }, count)}` : name;
};

const frame = phoneRailFrame();
</script>

<template>
    <nav
        class="icon-rail scrollbar-none flex shrink-0 items-center overflow-x-auto overscroll-contain border-t border-line bg-card px-2"
        :style="frame"
        :aria-label="t(`shared.sandboxes`)"
    >
        <template v-for="box in boxes" :key="box.id">
            <PhoneSandboxTile v-if="box.id === sandbox.activeSandboxId.value" class="ui-row-select-on shrink-0" aria-current="true" />
            <button
                v-else
                type="button"
                class="icon-rail-tile relative flex shrink-0 items-center justify-center rounded-xl active:bg-overlay"
                :class="{ 'opacity-40 grayscale': unreachable(box.id) }"
                :aria-label="labelOf(box.id, box.name)"
                @click="sandbox.select(box.id)"
            >
                <span class="flex size-full items-center justify-center overflow-hidden rounded-xl">
                    <SandboxLogo :image="box.image ?? null" :name="box.name" />
                </span>
                <ViewBadgeChip
                    v-if="waitingFor(box.id) > 0"
                    :badge="{ count: waitingFor(box.id) }"
                    class="icon-rail-mark pointer-events-none absolute right-0.5 top-0.5"
                    aria-hidden="true"
                />
            </button>
        </template>
    </nav>
</template>
