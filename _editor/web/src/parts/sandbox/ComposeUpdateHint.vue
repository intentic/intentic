<!-- The update for a sandbox Docker Compose may be running without saying so (a file from before SANDBOX_MANAGER):
     Compose's own two steps, which leave Compose its container where the `ic` command above would recreate it. -->
<script setup lang="ts">
import { COMPOSE_UPDATE_COMMAND } from "@intentic/sandbox-run";
import { CopyButton } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();
</script>

<template>
    <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-subtle">
        <span>{{ t(`capabilities.hostRecreate.startedWithCompose`) }}</span>
        <code class="font-mono text-content">{{ COMPOSE_UPDATE_COMMAND }}</code>
        <CopyButton :text="COMPOSE_UPDATE_COMMAND" />
    </p>
</template>
