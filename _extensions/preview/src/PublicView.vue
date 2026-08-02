<script setup lang="ts">
import { Button, cmp, CopyButton, Icon, InfoHint, StatusBadge } from "@intentic/extension-ui";
import { ref } from "vue";
import SharePreview from "./SharePreview.vue";
import { usePublic } from "./usePublic";

/* The Public view: the workspace's outbox, and the owner's only complete picture of it.
 *
 * The outbox has no auth in front of it, so the burden this screen carries is that nothing about what is
 * exposed can be a surprise. Three things follow from that. Files the guards REFUSE are listed as loudly as the
 * ones that are served, with the reason — the serve path deliberately tells a stranger nothing (every miss is
 * the same 404), which only works if the owner has somewhere that tells them everything. The empty state
 * explains the whole convention rather than showing an empty box, because "there is nothing here" and "this is
 * how publishing works" are the same sentence when the directory's existence IS the switch. And nothing here
 * says "shareable" without also saying public, in words, next to the link.
 *
 * Mounted as a tab on the sandbox hub (surface: "sandbox") beside Ports, so it renders a BODY — the hub owns
 * the Page and the header above the tab strip. */

const { files, url, servedCount, error, isLoading, unpublish } = usePublic();

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
        <div v-if="error || actionError" :class="cmp.alertDanger('px-4 py-3 text-sm')">{{ error ?? actionError }}</div>

        <section>
            <div class="mb-2 flex items-center gap-2">
                <h3 :class="cmp.sectionLabel()">Published</h3>
                <InfoHint label="Public files">
                    <span class="block text-sm font-medium text-content">Your public folder</span>
                    <span class="mt-1 block text-xs text-muted">
                        Anything inside <b>public/</b> in your workspace is served on the internet at the address below — no sign-in, no running
                        server. Drop a file in and it has a link; delete it and the link stops working. The folder disappears when the last file
                        leaves, so an empty workspace publishes nothing.
                    </span>
                </InfoHint>
                <StatusBadge v-if="servedCount > 0" variant="success" :label="`${servedCount} public`" size="xs" />
            </div>

            <!-- The address itself is worth showing even with nothing published: it is what makes the empty
                 state actionable, and it is the thing a user wants to copy once and keep. -->
            <div v-if="url" class="mb-3 flex items-center gap-2 rounded-lg border border-line bg-card px-4 py-2">
                <Icon name="globe" class="shrink-0 text-subtle" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" :title="url">{{ url }}</span>
                <CopyButton :text="url" label="Copy address" />
            </div>
            <div v-else class="mb-3 rounded-lg border border-line bg-card px-4 py-3 text-xs text-muted">
                This sandbox has no public address, so files can't be published from it.
            </div>

            <div
                v-if="files.length === 0 && !isLoading"
                class="flex flex-col items-center gap-2 rounded-lg border border-line bg-card py-10 text-center"
            >
                <Icon name="globe" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">Nothing is published.</p>
                <p class="text-2xs text-subtle">
                    Create a <span class="font-mono">public/</span> folder in your workspace and put a file in it — or ask the agent to publish
                    something for you.
                </p>
            </div>

            <div v-else-if="files.length > 0" class="rounded-lg border border-line bg-card">
                <div class="flex flex-col divide-y divide-line">
                    <div v-for="file in files" :key="file.path" class="flex items-center gap-3 px-4 py-2">
                        <Icon :name="file.blocked ? `times` : `file`" :class="file.blocked ? `shrink-0 text-danger` : `shrink-0 text-subtle`" />
                        <div class="min-w-0 flex-1">
                            <p class="truncate font-mono text-xs text-content" :title="file.path">{{ file.path }}</p>
                            <!-- A refused file is the one row that must explain itself: it is in the folder, so
                                 the owner believes it is published, and only this line says otherwise. -->
                            <p v-if="file.blocked" class="truncate text-2xs text-danger">Not served — {{ file.blocked }}</p>
                            <p v-else class="text-2xs text-subtle">{{ size(file.size) }}</p>
                        </div>
                        <StatusBadge v-if="file.blocked" variant="danger" label="blocked" size="xs" />
                        <a
                            v-if="file.url"
                            :href="file.url"
                            target="_blank"
                            rel="noopener"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                            :aria-label="`Open ${file.path} in a new tab`"
                            v-tooltip.bottom="'Open in new tab'"
                        >
                            <Icon name="external-link" />
                        </a>
                        <SharePreview v-if="file.url" :url="file.url" label="Share" />
                        <Button label="Unpublish" size="small" severity="secondary" :disabled="busy !== undefined" @click="withdraw(file.path)">
                            <template #icon><Icon name="trash" /></template>
                        </Button>
                    </div>
                </div>
            </div>
        </section>
    </div>
</template>
