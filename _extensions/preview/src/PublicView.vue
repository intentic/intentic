<script setup lang="ts">
import { Button, ui, CopyButton, Icon, InfoHint, Notice, noticeOf, StatusBadge, useLoadingReveal } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import SharedConversations from "./SharedConversations.vue";
import SharePreview from "./SharePreview.vue";
import { usePublic } from "./usePublic";
import { t } from "./i18n.js";

// Public view: the workspace's outbox, with no auth in front, so nothing exposed can be a surprise. Refused files are
// listed as loudly as served ones (with why); the empty state explains the publishing convention itself; a shareable
// link is always labeled public. Renders a BODY only; the hub owns the Page and header.

const { files, url, servedCount, error, isLoading, unpublish } = usePublic();
// Drawn only once the wait has earned it.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `public-files`),
);

const busy = ref<string>();
const actionError = ref<string>();

const withdraw = async (path: string): Promise<void> => {
    actionError.value = undefined;
    busy.value = path;
    try {
        await unpublish(path);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `The action failed.`;
    } finally {
        busy.value = undefined;
    }
};

const KB = 1024;
const size = (bytes: number): string => {
    if (bytes < KB) {
        return `${bytes} B`;
    }
    const units = [`KB`, `MB`, `GB`];
    let value = bytes / KB;
    let unit = 0;
    while (value >= KB && unit < units.length - 1) {
        value /= KB;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <Notice v-if="error ?? actionError" :of="noticeOf(error ?? actionError ?? ``)" />

        <!-- Renders nothing when empty; a shared conversation is the most sensitive item here, so it leads when present. -->
        <SharedConversations />

        <section>
            <div class="mb-2 flex items-center gap-2">
                <h3 :class="ui.sectionLabel()">{{ t(`publicView.published`) }}</h3>
                <InfoHint :label="t(`publicView.publicFiles`)">
                    <span class="block text-sm font-medium text-content">{{ t(`publicView.publicFolder`) }}</span>
                    <span class="mt-1 block text-xs text-muted">
                        {{ t(`publicView.anythingInside`) }} <b>public/</b> {{ t(`publicView.inWorkspaceServedOn`) }}
                    </span>
                </InfoHint>
                <StatusBadge v-if="servedCount > 0" variant="success" :label="t(`publicView.public2`, { servedCount })" size="xs" />
            </div>

            <!-- Shown even with nothing published: makes the empty state actionable and gives something to copy. -->
            <div v-if="url" class="mb-3 flex items-center gap-2 rounded-lg border border-line bg-card px-4 py-2">
                <Icon name="globe" class="shrink-0 text-subtle" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" :title="url">{{ url }}</span>
                <CopyButton :text="url" :label="t(`publicView.copyAddress`)" />
            </div>
            <div v-else class="mb-3 rounded-lg border border-line bg-card px-4 py-3 text-xs text-muted">
                {{ t(`publicView.sandboxNoPublicAddress`) }}
            </div>

            <!-- Empty list reads as 'nothing published' too quietly; skeleton rows (icon, path, size) stand in while loading. -->
            <div v-if="isLoading && outline" class="rounded-lg border border-line bg-card" role="status" aria-busy="true">
                <span class="sr-only">{{ t(`publicView.readingPublishedFiles`) }}</span>
                <div class="flex flex-col divide-y divide-line-subtle" aria-hidden="true">
                    <div v-for="row in 3" :key="row" class="flex items-center gap-3 px-4 py-2">
                        <span class="skeleton block h-3.5 w-3.5 shrink-0" />
                        <div class="flex min-w-0 flex-1 flex-col gap-1">
                            <span class="skeleton block h-2.5" :class="[`w-48`, `w-64`, `w-40`][row % 3]" />
                            <span class="skeleton block h-2 w-12" />
                        </div>
                        <span class="skeleton block h-3.5 w-10 shrink-0" />
                    </div>
                </div>
            </div>

            <div
                v-else-if="files.length === 0 && !isLoading"
                class="flex flex-col items-center gap-2 rounded-lg border border-line bg-card py-10 text-center"
            >
                <Icon name="globe" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">{{ t(`publicView.nothingPublished`) }}</p>
                <p class="text-2xs text-subtle">
                    {{ t(`publicView.create`) }} <span class="font-mono">public/</span>
                    {{ t(`publicView.folderInWorkspacePut`) }}
                </p>
            </div>

            <div v-else-if="files.length > 0" class="rounded-lg border border-line bg-card">
                <div class="flex flex-col divide-y divide-line-subtle">
                    <div v-for="file in files" :key="file.path" class="flex items-center gap-3 px-4 py-2">
                        <Icon :name="file.blocked ? `times` : `file`" :class="file.blocked ? `shrink-0 text-danger` : `shrink-0 text-subtle`" />
                        <div class="min-w-0 flex-1">
                            <p class="truncate font-mono text-xs text-content" :title="file.path">{{ file.path }}</p>
                            <!-- A blocked file sits in the folder looking published; this line is the only thing that says otherwise. -->
                            <p v-if="file.blocked" class="truncate text-2xs text-danger">
                                {{ t(`publicView.notServed`, { blocked: file.blocked }) }}
                            </p>
                            <p v-else class="text-2xs text-subtle">{{ size(file.size) }}</p>
                        </div>
                        <StatusBadge v-if="file.blocked" variant="danger" :label="t(`publicView.blocked`)" size="xs" />
                        <a
                            v-if="file.url"
                            :href="file.url"
                            target="_blank"
                            rel="noopener"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                            :aria-label="t(`publicView.openInNewTab`, { path: file.path })"
                            v-tooltip.bottom="t(`publicView.openInNewTab2`)"
                        >
                            <Icon name="external-link" />
                        </a>
                        <SharePreview v-if="file.url" :url="file.url" :label="t(`publicView.share`)" />
                        <Button
                            :label="t(`publicView.unpublish`)"
                            size="small"
                            severity="secondary"
                            :disabled="busy !== undefined"
                            @click="withdraw(file.path)"
                        >
                            <template #icon><Icon name="trash" /></template>
                        </Button>
                    </div>
                </div>
            </div>
        </section>
    </div>
</template>
