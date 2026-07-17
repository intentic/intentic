<script setup lang="ts">
import { Page } from "@intentic-app/ui";
import InfraDeclare from "./InfraDeclare.vue";

/* The infrastructure extension: the want-first declare surface of the intent repo. No onboarding gate — the
 * haves a want needs (a server, Cloudflare) surface as inline requirement cards inside InfraDeclare, defined
 * just-in-time. Always targets the intent repo (no repo prop); everything reaches the daemon directly through
 * the sandbox client. */
</script>

<template>
    <div class="h-full min-h-0 overflow-auto">
        <Page class="max-w-6xl">
            <header class="mb-6">
                <h1 class="text-2xl font-semibold">Infrastructure</h1>
                <p class="mt-1 text-sm text-muted">Run your own services on your own server.</p>
            </header>
            <InfraDeclare />
        </Page>
    </div>
</template>
