<script setup lang="ts">
import { Page, PageHeader } from "@intentic/ui";
import InfraDeclare from "./InfraDeclare.vue";

/* The infrastructure extension: the want-first declare surface of the intent repo. No onboarding gate, the
 * haves a want needs (a server, Cloudflare) surface as inline requirement cards inside InfraDeclare, defined
 * just-in-time. Always targets the intent repo (no repo prop); everything reaches the daemon directly through
 * the sandbox client. */
</script>

<template>
    <div class="scrollbar-thin h-full min-h-0 overflow-auto">
        <Page width="wide">
            <PageHeader title="Infrastructure" />
            <InfraDeclare />
        </Page>
    </div>
</template>
