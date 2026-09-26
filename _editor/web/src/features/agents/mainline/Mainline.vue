<script setup lang="ts">
import { Page, PageHeader, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { supportsRoute } from "../../sandbox/overview/useDaemonRoutes";
import SandboxOutdatedNotice from "../../sandbox/overview/version/SandboxOutdatedNotice.vue";
import MainlinePanel from "./MainlinePanel.vue";
import { mainlineSummary } from "./mainlineView";
import { useMainline } from "./useMainline";

// THE MAIN LINE, A VIEW OF ITS OWN (/ext/mainline, the rail's Main line tile): the check the main tree gets after every
// land. What it holds is diagnosis and a to-do list (what failed and who has it, what a push left), read instead of the
// board rather than beside it, so it takes the whole view instead of a drawer under the board that could show only a
// slice of it. The board's status bar keeps the at-a-glance answer and leads here; the panel is this page's body, laid
// out to its width.

const t = useT();

const status = useMainline();
const summary = computed(() => mainlineSummary(status.value));
// A sandbox from before the main line was served at all: nothing to show until it updates, which is not "nothing checked".
const unserved = computed(() => !supportsRoute(`workspace.mainline`));
</script>

<template>
    <div class="h-full min-h-0 overflow-auto">
        <Page width="full">
            <PageHeader :title="t(`agents.mainline.title`)" :description="t(`agents.mainline.description`)" />
            <SandboxOutdatedNotice v-if="unserved" :missing="t(`agents.mainline.unservedMissing`)" />
            <MainlinePanel v-else-if="status !== undefined && summary !== undefined" :status="status" :summary="summary" />
            <p v-else data-empty :class="ui.emptyState()">{{ t(`agents.mainline.nothingChecked`) }}</p>
        </Page>
    </div>
</template>
