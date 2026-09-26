<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";
import SandboxOutdatedNotice from "../../sandbox/overview/version/SandboxOutdatedNotice.vue";
import MainlineBoard from "./MainlineBoard.vue";
import { mainlineSummary } from "./mainlineView";
import { useMainline } from "./useMainline";

// THE MAIN LINE, A BOARD OF ITS OWN (/ext/mainline, the rail's Main line tile): the check the main tree gets after every
// land, laid out the way the fleet board lays out its agents. The lanes are the whole page: each says what it holds in a
// line under its name, so nothing above them restates what they show (MainlineBoard).

const t = useT();

const status = useMainline();
const summary = computed(() => mainlineSummary(status.value));
// A sandbox from before the main line was served at all: nothing to show until it updates, which is not "nothing checked".
const unserved = computed(() => !supportsRoute(`workspace.mainline`));
</script>

<template>
    <div class="relative flex h-full min-h-0 flex-col">
        <div v-if="unserved" class="p-4 sm:p-6">
            <SandboxOutdatedNotice :missing="t(`agents.mainline.unservedMissing`)" />
        </div>
        <MainlineBoard v-else-if="status !== undefined && summary !== undefined" :status="status" :summary="summary" />
        <!-- Nothing landed yet is the board's one true empty state: what it will hold, where the lanes would be. -->
        <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <Icon name="mainline" class="text-3xl text-subtle" />
            <p data-empty class="max-w-sm text-xs text-muted">{{ t(`agents.mainline.nothingChecked`) }}</p>
            <p class="max-w-md text-2xs text-subtle">{{ t(`agents.mainline.description`) }}</p>
        </div>
    </div>
</template>
