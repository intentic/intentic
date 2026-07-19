<script setup lang="ts">
import { Button, cmp, Icon, InfoHint, Page, StatusBadge } from "@intentic/extension-ui";
import { ref } from "vue";
import { usePorts } from "./usePorts";

/* The Ports view: every TCP port listening inside the sandbox (procfs scan), each attributed to its owning
 * process. "Preview" forwards the port onto its public port-<slot> hostname and opens it; forwarded rows keep
 * a live link until "Stop". Forwarding is the explicit exposure gesture — previews are public. */

const { ports, error, isLoading, forward, unforward } = usePorts();

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
    <div class="h-full min-h-0 overflow-auto">
        <Page class="max-w-none">
            <header class="mb-6">
                <div class="flex items-center gap-2">
                    <h1 class="text-2xl font-semibold">Ports</h1>
                    <InfoHint label="Ports">
                        <span class="block text-sm font-medium text-content">Listening ports</span>
                        <span class="mt-1 block text-xs text-muted">
                            Every TCP port something inside the sandbox is listening on — dev servers started in terminals, published containers,
                            anything. <b>Preview</b> makes one reachable in your browser through the sandbox's tunnel; a forwarded port stays public
                            until you stop it.
                        </span>
                    </InfoHint>
                </div>
                <p class="mt-1 text-sm text-muted">What's serving inside the sandbox — and which of it your browser can reach.</p>
            </header>

            <div v-if="error || actionError" :class="cmp.alertDanger('mb-4 px-4 py-3 text-sm')">{{ error ?? actionError }}</div>

            <div v-if="ports.length === 0 && !isLoading" class="flex flex-col items-center gap-2 py-16 text-center">
                <Icon name="desktop" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">Nothing is listening yet.</p>
                <p class="text-2xs text-subtle">Start a dev server in a terminal and it appears here.</p>
            </div>

            <section v-else class="rounded-lg border border-line bg-card">
                <div class="flex flex-col divide-y divide-line">
                    <div v-for="entry in ports" :key="entry.port" class="flex items-center gap-3 px-4 py-2">
                        <span class="w-14 shrink-0 font-mono text-sm text-content">{{ entry.port }}</span>
                        <StatusBadge v-if="entry.forwarded" variant="success" label="forwarded" size="xs" />
                        <div class="min-w-0 flex-1">
                            <p class="truncate font-mono text-xs text-muted" :title="entry.command">{{ entry.command ?? `unknown process` }}</p>
                            <p v-if="entry.cwd" class="truncate text-2xs text-subtle" :title="entry.cwd">{{ displayCwd(entry.cwd) }}</p>
                        </div>
                        <a
                            v-if="entry.previewUrl"
                            :href="entry.previewUrl"
                            target="_blank"
                            rel="noopener"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                            :aria-label="`Open the port ${entry.port} preview in a new tab`"
                            v-tooltip.bottom="'Open in new tab'"
                        >
                            <Icon name="external-link" />
                        </a>
                        <Button v-if="!entry.forwarded" label="Preview" size="small" :disabled="busy !== undefined" @click="openPreview(entry.port)">
                            <template #icon><Icon name="play" /></template>
                        </Button>
                        <Button v-else label="Stop" size="small" severity="secondary" :disabled="busy !== undefined" @click="stop(entry.port)">
                            <template #icon><Icon name="stop" /></template>
                        </Button>
                    </div>
                </div>
            </section>
        </Page>
    </div>
</template>
