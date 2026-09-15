<script setup lang="ts">
import { Page, PageHeader } from "@intentic/ui";
import InfraDeclare from "./InfraDeclare.vue";

/* The infrastructure extension: the want-first declare surface of the intent repo. */
</script>

<template>
    <div class="h-full min-h-0 overflow-auto">
        <Page width="wide">
            <PageHeader title="Infrastructure" />
            <InfraDeclare />
        </Page>
    </div>
</template>
