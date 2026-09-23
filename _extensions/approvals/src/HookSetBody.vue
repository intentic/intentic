<!-- One hook set as the owner approves it: every hook with the file that declares it and exactly what it runs, then the files it runs by name, whose bytes the approval pins. -->
<script setup lang="ts">
import type { HookRequest } from "@intentic/sandbox-contract";
import { t } from "./i18n.js";

const { request } = defineProps<{ request: HookRequest }>();
</script>

<template>
    <div class="flex max-w-read flex-col gap-2">
        <ul class="flex flex-col gap-1.5">
            <li v-for="(hook, index) in request.hooks" :key="index" class="flex flex-col gap-0.5">
                <span class="text-2xs text-muted">
                    {{ hook.declaredIn ?? (hook.source === `user` ? t(`hookSetBody.fromUserSettings`) : t(`hookSetBody.fromProjectSettings`)) }}
                    <span class="text-subtle"> · </span>{{ hook.event }}<template v-if="hook.matcher !== undefined"> ({{ hook.matcher }})</template>
                    <span class="text-subtle"> · </span>{{ hook.type }}
                </span>
                <code class="block whitespace-pre-wrap break-all font-mono text-2xs text-content">{{ hook.run }}</code>
            </li>
        </ul>
        <div v-if="request.scripts.length > 0" class="flex flex-col gap-0.5">
            <span class="text-2xs text-muted">{{ t(`hookSetBody.filesPinned`) }}</span>
            <code v-for="script in request.scripts" :key="script.path" class="block truncate font-mono text-2xs text-subtle" v-tooltip.top="script.sha256">{{
                script.path
            }}</code>
        </div>
    </div>
</template>
