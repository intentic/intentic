<!-- THE SANDBOX OPEN NOW, ON A PHONE: its logo, the way to the Menu page (every sandbox, what this one needs, who is here).
     Atop the phone's rail while it is the only sandbox, and in its place in the sandbox bar along the foot once there are
     more (PhoneSandboxBar.vue), so it is drawn once, wherever the other sandboxes are. The same three corners as the
     desktop's switcher: what it needs from its owner (the badge), where it runs and whether it answers (the placement
     mark, inked by the connection), and work under way that ends by replacing it (the turning mark). -->
<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import { SandboxLogo } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import TileMark from "../../../components/TileMark.vue";
import { sandboxAvailabilityVisual } from "../../../features/sandbox/overview/availability";
import { useSandboxAttention } from "../../../features/sandbox/overview/sandboxAttention";
import { useSandboxAvailability } from "../../../features/sandbox/overview/useSandboxAvailability";
import { useSandboxPlacement } from "../../../features/sandbox/overview/useSandboxPlacement";
import { here, page } from "../../../lib/routes/links";
import { restartRunning, restartWaiting } from "../../../models/sandbox/live/sandboxRestart";
import { useWorkspaceTree } from "../../../models/workspace/tree/useWorkspaceTree";
import ViewBadgeChip from "../../../workbench/views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../../../workbench/views/viewBadge";

const t = useT();
const sandbox = useSandbox();
const { badge: attentionBadge } = useSandboxAttention();
const restarting = computed(() => restartRunning(sandbox.activeSandboxId.value));
// The same work once it waits on its owner to restart: the turning mark stops and is plated (SandboxSwitcher.vue).
const waiting = computed(() => restartWaiting(sandbox.activeSandboxId.value));
const WAITING_BADGE: ViewBadge = { mark: `refresh`, tone: `info` };
const placement = useSandboxPlacement();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
// No tooltip on a phone: the accessible name carries what the corners say.
const label = computed(() =>
    [sandbox.active.value?.name, t(`shared.menu`), attentionBadge.value?.tooltip, availabilityVisual.value.label, waiting.value, restarting.value]
        .filter((part) => part !== undefined && part !== ``)
        .join(` · `),
);
</script>

<template>
    <RouterLink
        :to="here(page.menu())"
        class="icon-rail-tile relative flex items-center justify-center overflow-visible rounded-xl"
        :aria-label="label"
    >
        <span class="flex size-full items-center justify-center overflow-hidden rounded-xl">
            <SandboxLogo :image="sandbox.active.value?.image ?? null" :name="sandbox.active.value?.name" />
        </span>
        <span
            v-if="placement"
            class="icon-rail-mark pointer-events-none absolute bottom-0.5 left-0.5 inline-flex h-[1.6em] w-[1.6em] items-center justify-center rounded-full bg-[color:var(--ui-tile-ground)] leading-none"
            :class="availabilityVisual.inkClass"
            aria-hidden="true"
        >
            <Icon :name="placement.icon" class="text-[0.9em]" />
        </span>
        <ViewBadgeChip :badge="attentionBadge" class="icon-rail-mark pointer-events-none absolute right-0.5 top-0.5" aria-hidden="true" />
        <ViewBadgeChip
            v-if="waiting !== undefined"
            :badge="WAITING_BADGE"
            class="icon-rail-mark pointer-events-none absolute bottom-0.5 right-0.5"
            aria-hidden="true"
        />
        <TileMark
            v-else-if="restarting !== undefined"
            name="spinner"
            spin
            :class="[RUNNING_MARK_CLASS, `icon-rail-mark pointer-events-none absolute bottom-0.5 right-0.5`]"
        />
    </RouterLink>
</template>
