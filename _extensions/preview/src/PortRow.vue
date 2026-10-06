<!-- One port, explained: which port, what it is, and where it came from, with the raw command line, directory and pid one click down. -->
<script setup lang="ts">
import { Button, DisclosureRow, type IconName, Icon, InfoTable, StatusBadge, ui } from "@intentic/extension-ui";
import type { PortSummary } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import SharePreview from "./SharePreview.vue";
import { t } from "./i18n.js";

const { entry, busy = false } = defineProps<{ entry: PortSummary; busy?: boolean }>();
const emit = defineEmits<{ preview: []; stop: []; terminal: [session: string] }>();

// Origin marks must match the corresponding section's icon.
const ORIGIN_ICONS = {
    terminal: `terminal`,
    agent: `robot`,
    panel: `play`,
    extension: `extensions`,
    container: `box`,
    sandbox: `server`,
    unknown: `question-circle`,
} as const satisfies Record<PortSummary[`origin`], IconName>;

const open = ref(false);

const openTerminal = (): void => {
    if (entry.session !== undefined) {
        emit(`terminal`, entry.session);
    }
};

// The facts the headline no longer shows, in the order somebody debugging asks for them. Always four rows, so
// an absent one reads as "we looked and there was nothing" rather than as a row that quietly went missing.
const details = computed<string[][]>(() => [
    [t(`portRow.command`), entry.command ?? t(`portRow.commandUnreadable`)],
    [t(`portRow.folder`), entry.cwd ?? t(`portRow.notReadable`)],
    [t(`portRow.terminal`), entry.session ?? t(`portRow.noTerminal`)],
    [t(`portRow.address`), `${entry.host}:${entry.port}${entry.pid === undefined ? `` : `  ·  ${t(`portRow.process`, { pid: entry.pid })}`}`],
]);
</script>

<template>
    <DisclosureRow v-model:open="open" density="compact" hit="pair">
        <!-- The origin glyph and the port number share the lead column; the trailing chevron is the pair's hit area. -->
        <template #lead="{ iconClass }">
            <Icon :name="ORIGIN_ICONS[entry.origin]" class="shrink-0 text-muted" :class="iconClass" />
            <!-- The port number is what the reader came looking for, and a fixed width is what makes a column of them scannable rather than ragged. -->
            <span class="w-12 shrink-0 font-mono text-sm text-content">{{ entry.port }}</span>
        </template>

        <template #title>
            <span class="block truncate" v-tooltip.top="entry.command">{{ entry.title }}</span>
        </template>

        <!-- What it is for, and the terminal it lives in when there is one. -->
        <template #description>
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span>{{ entry.purpose }}</span>
                <button
                    v-if="entry.session"
                    type="button"
                    :class="ui.textAction(`touch-target my-0 min-h-0 shrink-0 gap-1 text-2xs`)"
                    v-tooltip.bottom="t(`portRow.openTerminal`)"
                    @click="openTerminal"
                >
                    <Icon name="desktop" class="shrink-0" />
                    {{ entry.session }}
                </button>
            </span>
        </template>

        <template v-if="entry.forwarded" #meta>
            <StatusBadge variant="success" :label="t(`portRow.forwarded`)" size="xs" />
        </template>

        <!-- VERBS ONLY. -->
        <template #control>
            <a
                v-if="entry.previewUrl"
                :href="entry.previewUrl"
                target="_blank"
                rel="noopener"
                :class="ui.iconButton(`h-8 w-8`)"
                :aria-label="t(`portRow.openPortPreviewIn`, { port: entry.port })"
                v-tooltip.bottom="t(`common.newTab`)"
            >
                <Icon name="external-link" />
            </a>
            <!-- A forwarded port is public: offer the one-click shareable link right where it's exposed. -->
            <SharePreview v-if="entry.previewUrl" :url="entry.previewUrl" />
            <Button v-if="entry.forwarded" :label="t(`portRow.stop`)" size="small" severity="secondary" :disabled="busy" @click="emit(`stop`)">
                <template #icon><Icon name="stop" /></template>
            </Button>
            <!-- SECONDARY, LIKE THE STOP BESIDE IT AND LIKE EVERY OTHER ROW ACTION IN THE APP. -->
            <Button
                v-else-if="entry.forwardable"
                :label="t(`portRow.preview`)"
                size="small"
                severity="secondary"
                :disabled="busy"
                @click="emit(`preview`)"
            >
                <template #icon><Icon name="play" /></template>
            </Button>
            <span
                v-else
                class="shrink-0 text-2xs text-subtle"
                v-tooltip.bottom="{
                    title: t(`portRow.loopbackAlias`),
                    rows: [{ label: t(`portRow.address`), value: `${entry.host}:${entry.port}` }],
                    note: t(`portRow.proxyCantReach`),
                }"
            >
                {{ t(`portRow.notForwardable`) }}
            </span>
        </template>

        <template #below>
            <InfoTable :rows="details" />
        </template>
    </DisclosureRow>
</template>
