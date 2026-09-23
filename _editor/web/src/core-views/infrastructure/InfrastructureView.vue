<script setup lang="ts">
import { Page, PageHeader } from "@intentic/ui";
import InfraDeclare from "./InfraDeclare.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* The infrastructure extension: the want-first declare surface of the intent repo. */
</script>

<template>
    <div class="h-full min-h-0 overflow-auto">
        <Page width="wide">
            <PageHeader :title="t(`shared.infrastructure`)" />
            <InfraDeclare />
        </Page>
    </div>
</template>
