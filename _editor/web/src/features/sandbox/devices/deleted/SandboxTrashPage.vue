<script setup lang="ts">
import { Page, PageHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import RecentlyDeleted from "./RecentlyDeleted.vue";

// Account recovery cannot depend on the sandbox that was just removed. The Devices board embeds the same list.
const t = useT();
</script>

<template>
    <Page>
        <PageHeader :title="t(`sandbox.words.recentlyDeleted`)" />
        <RecentlyDeleted />
    </Page>
</template>
