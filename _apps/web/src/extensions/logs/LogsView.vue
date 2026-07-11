<script setup lang="ts">
import { cmp, InfoHint, Page, Segmented } from "@intentic-app/ui";
import { computed, ref, watch } from "vue";
import { formatBytes } from "../../pages/workspace/format";
import { useLogs, useLogTail } from "./useLogs";

/* The logs extension: the debug surface for everything the sandbox records under /history/logs — terminal
 * session captures (crashed ones included), intentic CLI run logs, and the daemon's own log. Read-only; the
 * files are written by the daemon/tmux only. */

const { files, error, isLoading } = useLogs();

const selected = ref<string>();
// Segmented models strings; the daemon route takes the numeric byte count.
const bytesChoice = ref(`65536`);
const bytes = computed(() => Number(bytesChoice.value));
const { tail, error: tailError, isLoading: tailLoading } = useLogTail(selected, bytes);

// Group the flat file list by its top-level dir so terminals / intentic-runs / daemon.log read as sections.
const groups = computed(() => {
    const byGroup = new Map<string, typeof files.value>();
    for (const file of files.value) {
        const group = file.name.includes(`/`) ? file.name.split(`/`)[0]! : `daemon`;
        byGroup.set(group, [...(byGroup.get(group) ?? []), file]);
    }
    return [...byGroup.entries()].map(([title, entries]) => ({ title, entries }));
});

// Auto-scroll to the newest lines whenever a fresh tail arrives.
const pane = ref<HTMLElement>();
watch(tail, () => {
    requestAnimationFrame(() => pane.value?.scrollTo({ top: pane.value.scrollHeight }));
});

const timeAgo = (at: number): string => {
    const minutes = Math.round((Date.now() - at) / 60_000);
    if (minutes < 1) {
        return `just now`;
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    if (minutes < 60 * 24) {
        return `${Math.round(minutes / 60)}h ago`;
    }
    return new Date(at).toLocaleString();
};
</script>

<template>
    <div class="h-full min-h-0 overflow-auto">
        <Page class="max-w-none">
            <header class="mb-6">
                <div class="flex items-center gap-2">
                    <h1 class="text-2xl font-semibold">Logs</h1>
                    <InfoHint label="Logs">
                        <span class="block text-sm font-medium text-content">Sandbox logs</span>
                        <span class="mt-1 block text-xs text-muted">
                            Everything the sandbox records for debugging: <b>terminals</b> — every tmux session's output (crashed ones included),
                            <b>intentic-runs</b> — infra plan/apply runs, and the <b>daemon</b>'s own log. Stored outside the agent's workspace and
                            survives rebuilds.
                        </span>
                    </InfoHint>
                </div>
                <p class="mt-1 text-sm text-muted">Terminal sessions, infra runs, and the sandbox daemon — durable and tamper-proof.</p>
            </header>

            <div v-if="error" :class="cmp.alertDanger('mb-4 px-4 py-3 text-sm')">{{ error }}</div>

            <div class="flex min-h-0 flex-col gap-4">
                <section class="rounded-lg border border-line bg-card p-4">
                    <h3 :class="cmp.sectionLabel('mb-3')">Files</h3>
                    <div v-for="group in groups" :key="group.title" class="mb-2">
                        <p class="mb-1 font-mono text-2xs uppercase text-subtle/70">{{ group.title }}</p>
                        <div class="flex flex-col divide-y divide-line">
                            <button
                                v-for="file in group.entries"
                                :key="file.name"
                                type="button"
                                class="flex items-center gap-3 py-1.5 text-left hover:bg-hover"
                                :class="selected === file.name ? `text-content` : `text-muted`"
                                @click="selected = file.name"
                            >
                                <Icon name="file" class="text-xs" :class="selected === file.name ? `text-link` : `text-subtle`" />
                                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ file.name }}</span>
                                <span class="shrink-0 text-2xs text-subtle">{{ formatBytes(file.sizeBytes) }}</span>
                                <span class="shrink-0 text-2xs text-subtle" :title="new Date(file.modifiedAt).toLocaleString()">
                                    {{ timeAgo(file.modifiedAt) }}
                                </span>
                            </button>
                        </div>
                    </div>
                    <p v-if="files.length === 0 && !isLoading" class="py-6 text-center text-sm text-muted">
                        Nothing yet. Logs appear as terminals run, infra commands execute, and the daemon works.
                    </p>
                </section>

                <section v-if="selected" class="rounded-lg border border-line bg-card p-4">
                    <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <h3 class="min-w-0 truncate font-mono text-xs text-content">{{ selected }}</h3>
                        <div class="flex items-center gap-2">
                            <span v-if="tail?.truncated" class="text-2xs text-subtle">tail of {{ formatBytes(tail.sizeBytes) }}</span>
                            <Segmented
                                v-model="bytesChoice"
                                :options="[
                                    { label: `64 KB`, value: `65536` },
                                    { label: `256 KB`, value: `262144` },
                                    { label: `1 MB`, value: `1048576` },
                                ]"
                            />
                        </div>
                    </div>
                    <div v-if="tailError" :class="cmp.alertDanger('mb-2')">
                        {{ tailError }}
                    </div>
                    <div ref="pane" class="max-h-128 overflow-auto rounded bg-surface p-3">
                        <pre class="whitespace-pre-wrap wrap-break-word font-mono text-xs text-muted">{{
                            tail?.text ?? (tailLoading ? `Loading…` : ``)
                        }}</pre>
                    </div>
                </section>
            </div>
        </Page>
    </div>
</template>
