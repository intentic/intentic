<script setup lang="ts">
import { appLink, Button, Icon, ProgressRing, ui } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { DocsState } from "./contract.js";
import { openDocument, startDocs } from "./docs.js";
import { host } from "./host.js";

/* A document in ONLYOFFICE Docs: an iframe on the editor's own origin once the document server answers, and until then a card saying what stands between the reader and it. */

// `agent` is the conversation whose checkout the file is read from; such a copy is never editable, like text.
const { path, agent } = defineProps<{ path: string; agent?: string }>();
defineEmits<{ download: [] }>();

// Between polls while the server is pulling or starting; the pull is minutes, a start is tens of seconds.
const POLL_MS = 1500;

const url = ref<string>();
const status = ref<DocsState>();
const failure = ref<string>();
// One-shot timers chained by hand, cleared on unmount; no repeating clock.
let pending: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

// Editing needs a tier that may write files, and the shared tree: a scoped copy can't be written into at all.
const editable = computed(() => agent === undefined && [`owner`, `maintainer`].includes(host().sandbox.role()));
const theme = (): `light` | `dark` => (document.documentElement.dataset[`mode`] === `dark` ? `dark` : `light`);

const settled = (state: DocsState): boolean => state.state !== `pulling` && state.state !== `starting`;

const load = async (): Promise<void> => {
    const mine = ++generation;
    clearTimeout(pending);
    failure.value = undefined;
    try {
        const result = await openDocument({ path, ...(agent === undefined ? {} : { agent }), mode: editable.value ? `edit` : `view`, theme: theme() });
        if (mine !== generation) {
            return;
        }
        if (`url` in result) {
            status.value = undefined;
            url.value = result.url;
            return;
        }
        status.value = result.status;
        if (!settled(result.status)) {
            pending = setTimeout(() => void load(), POLL_MS);
        }
    } catch (error) {
        if (mine === generation) {
            failure.value = error instanceof Error ? error.message : String(error);
        }
    }
};

// The button locks itself while this runs (the kit's Button does that for an async handler).
const start = async (): Promise<void> => {
    try {
        status.value = await startDocs();
        await load();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    }
};

watch(
    () => [path, agent] as const,
    () => {
        url.value = undefined;
        status.value = undefined;
        void load();
    },
    { immediate: true },
);
onBeforeUnmount(() => {
    generation++;
    clearTimeout(pending);
});

const percent = computed(() => (status.value?.state === `pulling` ? status.value.percent : undefined));
// A real link: hover, right-click and Ctrl/Cmd-click behave as on any address.
const capabilitiesLink = appLink(host().href(`/capabilities`), () => host().navigate(`/capabilities`));
</script>

<template>
    <iframe v-if="url" :src="url" class="h-full w-full border-0" allow="clipboard-read; clipboard-write" :title="path" />
    <div v-else class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <template v-if="failure">
            <Icon name="exclamation-circle" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ failure }}</p>
            <Button severity="secondary" class="mt-1" @click="load">Try again</Button>
        </template>
        <template v-else-if="status?.state === 'docker-off'">
            <Icon name="file-edit" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">ONLYOFFICE Docs runs as a container in this sandbox's Docker engine, which isn't on. {{ status.detail }}</p>
            <a v-bind="capabilitiesLink" :class="ui.linkButton(`mt-1`)">Open capabilities</a>
        </template>
        <template v-else-if="status?.state === 'not-started'">
            <Icon name="file-edit" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">Open, edit and save this document in ONLYOFFICE Docs. The first start downloads the document server, about 2 GB, once.</p>
            <Button class="mt-1" @click="start">Start ONLYOFFICE Docs</Button>
        </template>
        <template v-else-if="status?.state === 'pulling'">
            <ProgressRing :value="percent ?? 0" :size="40" :stroke="3" />
            <p class="max-w-sm text-sm text-muted">Downloading ONLYOFFICE Docs{{ percent === undefined ? `` : `, ${percent}%` }}…</p>
        </template>
        <template v-else-if="status?.state === 'starting'">
            <Icon name="spinner" spin class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">Starting the document server…</p>
        </template>
        <template v-else-if="status?.state === 'no-address'">
            <Icon name="exclamation-circle" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">The editor needs an address the browser can reach. Your sandbox isn't reachable from outside yet: finish setup so it registers its address.</p>
            <Button severity="secondary" class="mt-1" @click="load">Try again</Button>
        </template>
        <template v-else-if="status?.state === 'error'">
            <Icon name="exclamation-circle" class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">{{ status.detail }}</p>
            <Button severity="secondary" class="mt-1" @click="load">Try again</Button>
        </template>
        <template v-else>
            <Icon name="spinner" spin class="text-4xl text-subtle" />
            <p class="max-w-sm text-sm text-muted">Opening in ONLYOFFICE Docs…</p>
        </template>
    </div>
</template>
