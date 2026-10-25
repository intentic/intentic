<!-- WHICH SANDBOX THE MASTER VIEW IS TALKING TO, and the way into it. The rail's tiles are pictures, and the chat under
     this bar is the selected sandbox's home conversation: without a name over it, nothing on the page said whose. Its one
     press opens the sandbox where it was last left (models/sandbox/sandboxScreen.ts `sandboxEntryPath`), its agents board
     the first time: the drill-in that used to be a double-click only a tooltip mentioned. A home-only guest has no
     sandbox to enter, so it gets no press. On a phone the bar also leads back to the list of sandboxes, the master view
     there being that list (MasterHomeView.vue). -->
<script setup lang="ts">
import { Button, SandboxLogo } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useRole } from "../../client/sandbox/useRole";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { sandboxEntryPath } from "../../models/sandbox/sandboxScreen";
import { useWorkspaceTree } from "../../models/workspace/tree/useWorkspaceTree";
import { sandboxAvailabilityVisual } from "../sandbox/overview/availability";
import { useSandboxAvailability } from "../sandbox/overview/useSandboxAvailability";
import { useSandboxPlacement } from "../sandbox/overview/useSandboxPlacement";

const { phone = false } = defineProps<{ phone?: boolean }>();

const t = useT();
const router = useRouter();
const sandbox = useSandbox();
const { homeOnly } = useRole();
const placement = useSandboxPlacement();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const visual = computed(() => sandboxAvailabilityVisual(availability.value));
const name = computed(() => sandbox.active.value?.name ?? ``);

const open = (): void => {
    const id = sandbox.activeSandboxId.value;
    if (id !== undefined) {
        void router.push(sandboxEntryPath(id));
    }
};
</script>

<template>
    <header class="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2" data-home-sandbox-bar>
        <RouterLink
            v-if="phone"
            :to="HOME_PATH"
            class="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-content/5 hover:text-content"
            :aria-label="t(`home.open`)"
        >
            <Icon name="arrow-left" aria-hidden="true" />
        </RouterLink>
        <SandboxLogo :size="32" :image="sandbox.active.value?.image ?? null" :name="name" class="shrink-0 rounded-lg" />
        <div class="flex min-w-0 flex-1 flex-col">
            <h1 class="truncate text-sm font-semibold text-content">{{ name }}</h1>
            <p class="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
                <span class="size-1.5 shrink-0 rounded-full" :class="visual.dotClass" aria-hidden="true"></span>
                <span class="shrink-0">{{ visual.label }}</span>
                <template v-if="placement">
                    <span class="text-subtle" aria-hidden="true">·</span>
                    <span class="flex min-w-0 items-center gap-1 truncate" v-tooltip.bottom="placement.tip.rows === undefined ? undefined : placement.tip">
                        <Icon :name="placement.icon" class="shrink-0 text-subtle" aria-hidden="true" />
                        <span class="truncate">{{ placement.label }}</span>
                    </span>
                </template>
            </p>
        </div>
        <Button
            v-if="!homeOnly"
            :label="phone ? t(`home.openSandboxShort`) : t(`home.openSandbox`)"
            tier="boring"
            size="small"
            icon-pos="right"
            :aria-label="t(`home.openSandboxNamed`, { name })"
            data-home-open-sandbox
            @click="open"
        >
            <!-- PrimeVue hands the slot the classes that put an icon on its side; a slot that drops them draws it first. -->
            <template #icon="{ class: side }"><Icon name="arrow-right" :class="side" aria-hidden="true" /></template>
        </Button>
    </header>
</template>
