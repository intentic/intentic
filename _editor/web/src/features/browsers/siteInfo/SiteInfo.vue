<script setup lang="ts">
import type { BrowserPermission, PermissionSetting } from "@intentic/sandbox-contract/schemas/browser-tools";
import { AnchoredOverlay, Button, Icon, SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { SiteInfoTools } from "./useSiteInfo";
import { DECIDED, PERMISSION_ICONS, permissionWords, siteName } from "./permissionWords";

// The padlock's popover: whether the page in front travels privately, what its site may do in this window's profile,
// each changed where it is read, and clearing everything the site keeps here (which signs the person out of it).

const { tools, secure } = defineProps<{ tools: SiteInfoTools; secure: boolean }>();
const t = useT();

const site = computed(() => siteName(tools.origin.value));
const settingOf = (permission: BrowserPermission): PermissionSetting =>
    tools.site.value?.permissions.find((one) => one.permission === permission)?.setting ?? `ask`;
const choices = computed(() => [
    { label: t(`browsers.tools.allow`), value: `allow` as const },
    { label: t(`browsers.tools.ask`), value: `ask` as const },
    { label: t(`browsers.tools.block`), value: `block` as const },
]);
</script>

<template>
    <AnchoredOverlay v-model="tools.open.value" :anchor="tools.anchor.value" side="bottom" cross="start">
        <div class="flex w-80 flex-col gap-3 p-3.5" role="dialog" :aria-label="t(`browsers.tools.siteInfo`)">
            <div class="flex items-start gap-2 text-xs">
                <Icon :name="secure ? `lock` : `unlock`" class="shrink-0" :class="secure ? 'text-success' : 'text-warning'" />
                <div class="min-w-0 flex-1">
                    <div class="truncate text-xs font-medium text-content">{{ site ?? t(`browsers.tools.thisPage`) }}</div>
                    <div class="text-2xs text-muted">{{ secure ? t(`browsers.tools.secure`) : t(`browsers.tools.insecure`) }}</div>
                </div>
            </div>
            <template v-if="site">
                <div class="flex flex-col gap-1.5">
                    <div v-for="permission in DECIDED" :key="permission" class="flex items-center gap-2">
                        <Icon :name="PERMISSION_ICONS[permission]" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 truncate text-xs text-content">{{ permissionWords(permission) }}</span>
                        <SegmentedControl
                            :model-value="settingOf(permission)"
                            :options="choices"
                            size="xs"
                            :aria-label="permissionWords(permission)"
                            @update:model-value="(setting: PermissionSetting) => tools.set(permission, setting)"
                        />
                    </div>
                    <div class="flex items-center gap-2 text-2xs text-muted">
                        <Icon name="camera" class="shrink-0 text-2xs" />
                        <span>{{ t(`browsers.tools.noDevices`) }}</span>
                    </div>
                </div>
                <p v-if="tools.error.value" class="text-2xs text-danger">{{ tools.error.value }}</p>
                <div class="border-t border-line pt-3">
                    <Button size="small" tier="quiet" tone="danger" :label="t(`browsers.tools.clearSite`)" @click="tools.clear()">
                        <template #icon><Icon name="eraser" /></template>
                    </Button>
                    <p class="mt-1 text-3xs text-muted">{{ t(`browsers.tools.clearSiteNote`) }}</p>
                </div>
            </template>
        </div>
    </AnchoredOverlay>
</template>
