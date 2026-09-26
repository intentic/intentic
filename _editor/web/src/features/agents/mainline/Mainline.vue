<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";
import SandboxOutdatedNotice from "../../sandbox/overview/version/SandboxOutdatedNotice.vue";
import MainlineBoard from "./MainlineBoard.vue";
import MainlineSummary from "./MainlineSummary.vue";
import { mainlineSummary } from "./mainlineView";
import { useMainline } from "./useMainline";

// THE MAIN LINE, A BOARD OF ITS OWN (/ext/mainline, the rail's Main line tile): the check the main tree gets after every
// land, laid out the way the fleet board lays out its agents. Its header says at a glance what the board says in full
// (whether main passes, what the check is doing, what pushes left), where the fleet board keeps its own controls, so the
// two views' headers line up with the chat's beside them; the lanes are MainlineBoard's.

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
        <template v-else-if="status !== undefined && summary !== undefined">
            <header
                data-summary
                :aria-label="t(`agents.mainline.board.summary`)"
                class="view-header view-header-wrap flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1 text-xs"
            >
                <MainlineSummary :summary="summary" />
            </header>
            <MainlineBoard :status="status" :summary="summary" />
        </template>
        <!-- Nothing landed yet is the board's one true empty state: what it will hold, where the lanes would be. -->
        <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <Icon name="mainline" class="text-3xl text-subtle" />
            <p data-empty class="max-w-sm text-xs text-muted">{{ t(`agents.mainline.nothingChecked`) }}</p>
            <p class="max-w-md text-2xs text-subtle">{{ t(`agents.mainline.description`) }}</p>
        </div>
    </div>
</template>
