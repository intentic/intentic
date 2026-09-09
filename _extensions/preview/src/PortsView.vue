<script setup lang="ts">
import { Icon, InfoHint, Notice, noticeOf, openForwardedPort, RowGroup, SkeletonRows, useLoadingReveal } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { host } from "./host";
import PortRow from "./PortRow.vue";
import { usePorts } from "./usePorts";

// Ports view: every listening TCP port inside the sandbox, named/attributed by the daemon and grouped by owner (your
// work above, sandbox internals muted below). Preview forwards a port to its public port-<slot> hostname, the only
// public-exposure gesture. Renders a BODY only; the hub owns the Page and header.

const { ports, error, isLoading, forward, unforward } = usePorts();
// Drawn only once the wait has earned it: a procfs scan usually answers inside the reveal delay.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `ports`),
);
const workspacePorts = computed(() => ports.value.filter((entry) => entry.kind === `workspace`));
const systemPorts = computed(() => ports.value.filter((entry) => entry.kind === `system`));

const busy = ref<number>();
const actionError = ref<string>();

// Opens a tab synchronously on click, narrates the wait, navigates once the address answers. No `busy` here: the wait
// happens in the other tab, so this view's buttons stay live during DNS propagation.
const openPreview = (port: number): void => {
    actionError.value = undefined;
    openForwardedPort({
        port,
        forward,
        onError: (message) => {
            actionError.value = message;
        },
    });
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

const openTerminal = (session: string): void => host().terminal.open(session);
</script>

<template>
    <div class="flex flex-col gap-4">
        <Notice v-if="error ?? actionError" :of="noticeOf(error ?? actionError ?? ``)" />

        <RowGroup label="Your services">
            <template #info>
                <InfoHint label="Ports">
                    <span class="block text-sm font-medium text-content">What is listening here</span>
                    <span class="mt-1 block text-xs text-muted">
                        Every TCP port something inside the sandbox is listening on: dev servers you or an agent started, ports your containers
                        publish, anything at all. Each row is named from the process behind it; open the <b>ⓘ</b> for the exact command, folder and
                        terminal. <b>Preview</b> makes one reachable in your browser through the sandbox's tunnel; a forwarded port stays public until
                        you stop it.
                    </span>
                    <!-- Ports here means public forwarding, not localhost mirroring (Devices); avoids the wrong-index confusion. -->
                    <span class="mt-2 block text-xs text-muted">
                        Looking for a port on your own <b>localhost</b> instead? That is desktop sync mirroring it onto your machine: Devices says
                        which ports made it, and which one another sandbox got to first.
                    </span>
                </InfoHint>
            </template>

            <!-- An empty scan result would read as 'nothing found' with less confidence; skeleton rows stand in while loading. -->
            <div v-if="isLoading && outline" role="status" aria-busy="true">
                <span class="sr-only">Scanning for listening ports…</span>
                <SkeletonRows :rows="3" density="compact" description control />
            </div>

            <div v-else-if="!isLoading && workspacePorts.length === 0" class="flex flex-col items-center gap-2 py-10 text-center">
                <Icon name="ports" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">Nothing of yours is listening yet.</p>
                <p class="text-2xs text-subtle">Start a dev server in a terminal and it appears here.</p>
            </div>

            <PortRow
                v-for="entry in workspacePorts"
                :key="entry.port"
                :entry="entry"
                :busy="busy !== undefined"
                @preview="openPreview(entry.port)"
                @stop="stop(entry.port)"
                @terminal="openTerminal"
            />
        </RowGroup>

        <!-- Listed for transparency, muted since nobody previews these; forwarding stays possible, just de-emphasized. -->
        <RowGroup v-if="systemPorts.length > 0" label="Sandbox internals" class="opacity-70">
            <template #info>
                <InfoHint label="Internals">
                    <span class="block text-sm font-medium text-content">The sandbox's own services</span>
                    <span class="mt-1 block text-xs text-muted">
                        These come with the sandbox and run whether or not you start anything: the service this app talks to, the agent runtimes,
                        Docker's plumbing, an extension's background worker. They are listed so nothing is hidden from you, not because there is
                        anything to do with them.
                    </span>
                </InfoHint>
            </template>

            <PortRow
                v-for="entry in systemPorts"
                :key="entry.port"
                :entry="entry"
                :busy="busy !== undefined"
                @preview="openPreview(entry.port)"
                @stop="stop(entry.port)"
                @terminal="openTerminal"
            />
        </RowGroup>
    </div>
</template>
