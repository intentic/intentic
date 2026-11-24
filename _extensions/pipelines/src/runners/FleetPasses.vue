<script setup lang="ts">
import { Code, DisclosureRow } from "@intentic/extension-ui";
import { t } from "../i18n.js";
import type { PassView } from "./runnerFleet";

// The fleet service's last janitor, keeper and prune pass on one computer, folded: what a reader opens when a disk
// filled or a runner came back by itself, not what they read on every visit.

defineProps<{ passes: readonly PassView[] }>();
</script>

<template>
    <DisclosureRow v-for="pass in passes" :key="pass.kind" icon="clock" :title="pass.title" :description="pass.summary" body="drawer">
        <template #below>
            <Code v-if="pass.lines.length > 0" :code="pass.lines.join(`\n`)" :scroll-lines="20" />
            <p v-else class="text-xs text-muted">{{ t(`runners.pass.noLines`) }}</p>
        </template>
    </DisclosureRow>
</template>
