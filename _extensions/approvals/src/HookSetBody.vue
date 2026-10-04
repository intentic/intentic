<!-- One hook set as the owner approves it: every hook with the file that declares it and exactly what it runs, each plugin's hooks module in plain words, the marketplaces settings add, then the files it runs by name, whose bytes the approval pins. -->
<script setup lang="ts">
import type { HookRequest, SettingsHook } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { moduleSentence, pluginOrigin } from "./hookSet.js";
import { t } from "./i18n.js";

const { request } = defineProps<{ request: HookRequest }>();

// A module's own row is said by its plugin's line below, so the list keeps to the classic hooks; a request filed before
// plugins were listed keeps every row.
const hooks = computed((): readonly SettingsHook[] => (request.plugins === undefined ? request.hooks : request.hooks.filter((hook) => hook.type !== `module`)));

const declaredBy = (hook: SettingsHook): string => {
    const file = hook.declaredIn ?? (hook.source === `user` ? t(`hookSetBody.fromUserSettings`) : t(`hookSetBody.fromProjectSettings`));
    return hook.plugin === undefined ? file : `${hook.plugin} · ${file}`;
};
</script>

<template>
    <div class="flex max-w-read flex-col gap-2">
        <ul v-if="hooks.length > 0" class="flex flex-col gap-1.5">
            <li v-for="(hook, index) in hooks" :key="index" class="flex flex-col gap-0.5">
                <span class="text-2xs text-muted">
                    {{ declaredBy(hook) }}
                    <span class="text-subtle"> · </span>{{ hook.event }}<template v-if="hook.matcher !== undefined"> ({{ hook.matcher }})</template>
                    <span class="text-subtle"> · </span>{{ hook.type }}
                </span>
                <code class="block whitespace-pre-wrap break-all font-mono text-2xs text-content">{{ hook.run }}</code>
            </li>
        </ul>
        <ul v-if="(request.plugins ?? []).length > 0" class="flex flex-col gap-1.5">
            <li v-for="plugin in request.plugins" :key="`${plugin.from}:${plugin.name}:${plugin.dir ?? ``}`" class="flex flex-col gap-0.5">
                <span class="text-2xs text-muted">
                    <span class="text-content">{{ plugin.name }}</span><span class="text-subtle"> · </span>{{ pluginOrigin(plugin) }}
                    <template v-if="plugin.dir !== undefined"><span class="text-subtle"> · </span><span class="font-mono">{{ plugin.dir }}</span></template>
                </span>
                <template v-if="plugin.module !== undefined">
                    <span class="text-xs" :class="plugin.module.unreadable === undefined ? `text-content` : `text-danger`">{{ moduleSentence(plugin.module) }}</span>
                    <span v-if="plugin.module.hooks.length > 0" class="text-2xs text-muted">
                        {{ t(`hookSetBody.actsOn`) }} <code class="font-mono text-subtle">{{ plugin.module.hooks.join(`, `) }}</code>
                    </span>
                    <span v-if="plugin.module.calls.length > 0" class="text-2xs text-muted">
                        {{ t(`hookSetBody.reachesFor`) }} <code class="font-mono text-subtle">{{ plugin.module.calls.join(`, `) }}</code>
                    </span>
                </template>
            </li>
        </ul>
        <ul v-if="(request.marketplaces ?? []).length > 0" class="flex flex-col gap-0.5">
            <li v-for="marketplace in request.marketplaces" :key="`${marketplace.source}:${marketplace.name}`" class="text-2xs text-muted">
                {{ t(`hookSetBody.marketplace`, { name: marketplace.name, location: marketplace.location }) }}
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
