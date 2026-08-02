<script setup lang="ts">
import { Button, cmp, Icon, InfoHint, Row, RowGroup, StatusBadge } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import SharePreview from "./SharePreview.vue";
import { usePorts } from "./usePorts";

/* The Ports view: every TCP port listening inside the sandbox (procfs scan), each attributed to its owning
 * process and grouped by the daemon's classification — the user's own work (dev servers, terminal processes,
 * published containers) leads; the sandbox's internals (agent runtimes, translator, docker plumbing) sit in a
 * muted section below, listed for transparency rather than previewing. "Preview" forwards the port onto its
 * public port-<slot> hostname and opens it; forwarded rows keep a live link until "Stop". Forwarding is the
 * explicit exposure gesture — previews are public.
 *
 * Mounted as a tab on the sandbox hub (surface: "sandbox"), so it renders a BODY — the hub owns the Page and
 * the header above the tab strip. What would have been the page's description rides the section's InfoHint. */

const { ports, error, isLoading, forward, unforward } = usePorts();
const workspacePorts = computed(() => ports.value.filter((entry) => entry.kind === `workspace`));
const systemPorts = computed(() => ports.value.filter((entry) => entry.kind === `system`));

const busy = ref<number>();
const actionError = ref<string>();

const PROBE_INTERVAL_MS = 3000;
// Generous: a slot's first forward on the intentic-provided tunnel waits on fresh DNS propagation.
const PROBE_GIVE_UP_MS = 120_000;

// Forward + open in one gesture: the tab must open synchronously inside the click's activation (popup
// blockers), so a blank tab opens first, narrates progress, and navigates once the forward + reachability
// probe land (`no-cors` resolves on ANY HTTP response and rejects only on DNS/socket failure).
const openPreview = async (port: number): Promise<void> => {
    actionError.value = undefined;
    busy.value = port;
    const tab = window.open(``, `_blank`);
    if (tab !== null) {
        tab.opener = null;
    }
    const show = (text: string): void => {
        if (tab !== null && !tab.closed) {
            tab.document.body.textContent = text;
        }
    };
    show(`Forwarding port ${port} from your sandbox…`);
    try {
        const url = await forward(port);
        if (url === undefined) {
            show(`This sandbox has no public preview hostname, so ports can't be previewed from the browser.`);
            return;
        }
        show(`Waiting for ${url} to come up…`);
        const startedAt = Date.now();
        for (;;) {
            if (tab !== null && tab.closed) {
                return;
            }
            try {
                await fetch(url, { mode: `no-cors`, cache: `no-store` });
                break;
            } catch {
                if (Date.now() - startedAt > PROBE_GIVE_UP_MS) {
                    show(
                        `The preview address didn't come up — the server may have stopped, or DNS is still propagating. Close this tab and try again.`,
                    );
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
            }
        }
        if (tab !== null && !tab.closed) {
            tab.location.href = url;
        }
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Forwarding failed.`;
        show(actionError.value);
    } finally {
        busy.value = undefined;
    }
};

const stop = async (port: number): Promise<void> => {
    actionError.value = undefined;
    busy.value = port;
    try {
        await unforward(port);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `The action failed.`;
    } finally {
        busy.value = undefined;
    }
};

// Cosmetic: the workspace mounts at /work, so a cwd reads better repo-relative.
const displayCwd = (cwd: string): string => cwd.replace(/^\/work\//, ``);
</script>

<template>
    <div class="flex flex-col gap-4">
        <div v-if="error || actionError" :class="cmp.alertDanger('px-4 py-3 text-sm')">{{ error ?? actionError }}</div>

        <RowGroup label="Listening">
            <template #info>
                <InfoHint label="Ports">
                    <span class="block text-sm font-medium text-content">Listening ports</span>
                    <span class="mt-1 block text-xs text-muted">
                        Every TCP port something inside the sandbox is listening on — dev servers started in terminals, published containers,
                        anything.
                        <b>Preview</b> makes one reachable in your browser through the sandbox's tunnel; a forwarded port stays public until you stop
                        it.
                    </span>
                </InfoHint>
            </template>

            <div v-if="workspacePorts.length === 0 && !isLoading" class="flex flex-col items-center gap-2 py-10 text-center">
                <Icon name="desktop" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">Nothing of yours is listening yet.</p>
                <p class="text-2xs text-subtle">Start a dev server in a terminal and it appears here.</p>
            </div>

            <Row v-for="entry in workspacePorts" :key="entry.port" density="compact">
                <!-- The port number leads because it is what the reader came looking for, and a fixed width is
                     what makes a column of them scannable rather than ragged. -->
                <template #lead>
                    <span class="w-14 shrink-0 font-mono text-sm text-content">{{ entry.port }}</span>
                    <StatusBadge v-if="entry.forwarded" variant="success" label="forwarded" size="xs" />
                </template>
                <template #title>
                    <span class="block truncate font-mono text-xs font-normal text-muted" :title="entry.command">
                        {{ entry.command ?? `unknown process` }}
                    </span>
                </template>
                <template #description>
                    <span v-if="entry.cwd" class="block truncate" :title="entry.cwd">{{ displayCwd(entry.cwd) }}</span>
                </template>

                <template #control>
                    <a
                        v-if="entry.previewUrl"
                        :href="entry.previewUrl"
                        target="_blank"
                        rel="noopener"
                        :class="cmp.iconButton(`h-8 w-8`)"
                        :aria-label="`Open the port ${entry.port} preview in a new tab`"
                        v-tooltip.bottom="'Open in new tab'"
                    >
                        <Icon name="external-link" />
                    </a>
                    <!-- A forwarded port is public — offer the one-click shareable link right where it's exposed. -->
                    <SharePreview v-if="entry.previewUrl" :url="entry.previewUrl" />
                    <Button v-if="entry.forwarded" label="Stop" size="small" severity="secondary" :disabled="busy !== undefined" @click="stop(entry.port)">
                        <template #icon><Icon name="stop" /></template>
                    </Button>
                    <Button v-else-if="entry.forwardable" label="Preview" size="small" :disabled="busy !== undefined" @click="openPreview(entry.port)">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                    <span v-else class="shrink-0 text-2xs text-subtle" v-tooltip.bottom="'Bound to a loopback alias the preview proxy cannot reach.'">
                        not forwardable
                    </span>
                </template>
            </Row>
        </RowGroup>

        <!-- The sandbox's own machinery — visible for transparency, muted because nobody previews it.
             Forwarding stays possible (it's explicitly gated anyway), just de-emphasized. -->
        <RowGroup v-if="systemPorts.length > 0" label="Sandbox internals" class="opacity-70">
            <Row v-for="entry in systemPorts" :key="entry.port" density="compact">
                <template #lead>
                    <span class="w-14 shrink-0 font-mono text-xs text-muted">{{ entry.port }}</span>
                    <StatusBadge v-if="entry.forwarded" variant="success" label="forwarded" size="xs" />
                </template>
                <template #title>
                    <span class="block truncate font-mono text-2xs font-normal text-subtle" :title="entry.command">
                        {{ entry.command ?? `unknown process` }}
                    </span>
                </template>

                <template #control>
                    <a
                        v-if="entry.previewUrl"
                        :href="entry.previewUrl"
                        target="_blank"
                        rel="noopener"
                        :class="cmp.iconButton(`h-7 w-7`)"
                        :aria-label="`Open the port ${entry.port} preview in a new tab`"
                        v-tooltip.bottom="'Open in new tab'"
                    >
                        <Icon name="external-link" />
                    </a>
                    <Button v-if="entry.forwarded" label="Stop" size="small" severity="secondary" :disabled="busy !== undefined" @click="stop(entry.port)">
                        <template #icon><Icon name="stop" /></template>
                    </Button>
                    <Button
                        v-else-if="entry.forwardable"
                        label="Preview"
                        size="small"
                        severity="secondary"
                        :disabled="busy !== undefined"
                        @click="openPreview(entry.port)"
                    >
                        <template #icon><Icon name="play" /></template>
                    </Button>
                    <span v-else class="shrink-0 text-2xs text-subtle" v-tooltip.bottom="'Bound to a loopback alias the preview proxy cannot reach.'">
                        not forwardable
                    </span>
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
