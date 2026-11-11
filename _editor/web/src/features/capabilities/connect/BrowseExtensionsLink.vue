<!-- Where extensions are found, on the tile people arrive at wanting one: the registry's Browse tab, with what it holds. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { here, page } from "../../../lib/routes/links";

const t = useT();

const { publishedCount, verifiedCount } = defineProps<{
    // What the registry cache already holds; nothing until something has actually browsed it.
    publishedCount: number;
    verifiedCount: number;
}>();
</script>

<template>
    <RouterLink
        :to="here(page.sandboxSettings(`extensions`, { query: { view: `browse` } }))"
        class="flex items-center gap-3 rounded-lg bg-card shadow-sm px-3 py-2.5 transition-colors hover:bg-overlay"
    >
        <Icon name="search" class="shrink-0 text-link" />
        <span class="min-w-0 flex-1">
            <span class="block text-xs font-medium text-content">{{ t(`capabilities.capabilities.browsePublishedExtensions`) }}</span>
            <span class="block text-2xs text-muted">
                <template v-if="publishedCount > 0"
                    >{{ t(`capabilities.capabilities.publishedCount`, { count: publishedCount })
                    }}<template v-if="verifiedCount > 0">{{ t(`capabilities.capabilities.sourceReadByHuman`, { verifiedCount }) }}</template
                    >. </template
                >{{ t(`capabilities.capabilities.installInClickRegistry`) }}
            </span>
        </span>
        <Icon name="arrow-right" class="shrink-0 text-subtle" />
    </RouterLink>
</template>
