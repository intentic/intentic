<script setup lang="ts">
import { Icon, InfoHint, Notice, noticeOf, openForwardedPort, RowGroup, SkeletonRows, useLoadingReveal } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { host } from "./host";
import PortRow from "./PortRow.vue";
import { usePorts } from "./usePorts";

/* The Ports view: every TCP port listening inside the sandbox (procfs scan), each NAMED and attributed by the
 * daemon (ports/port-identity.ts) and grouped by whose it is: the user's own work (dev servers, terminal
 * processes, published container ports) leads; the sandbox's internals (its own service, the agent runtimes,
 * the translator, docker plumbing) sit in a muted section below, listed for transparency rather than previewing.
 * "Preview" forwards the port onto its public port-<slot> hostname and opens it; forwarded rows keep a live link
 * until "Stop". Forwarding is the explicit exposure gesture: previews are public.
 *
 * WHAT IT IS, NOT WHAT IT RAN. This view used to render each row's argv as its headline, which meant the
 * explanation of a port somebody was being invited to publish read `node --report-on-fatalerror
 * --report-directory=/history/logs /opt/sandbox/dist/main.js`, and three separate rows were that one process.
 * Now the row leads with the name and the sentence the daemon resolved, the terminal it descends from stays one
 * click away, and the raw evidence lives under the row's own disclosure for whoever actually needs it.
 *
 * Mounted as a tab on the sandbox hub (surface: "sandbox"), so it renders a BODY, the hub owns the Page and
 * the header above the tab strip. What would have been the page's description rides the section's InfoHint. */

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

/* Forward + open in one gesture, the kit's (openForwardedPort): a blank tab opens synchronously inside the
 * click's activation, narrates the wait, and navigates once the address answers.
 *
 * It takes no `busy` because the waiting happens in the OTHER tab. Holding this one's buttons disabled for the
 * up-to-two-minute DNS propagation, which is what the local copy of this flow did: locked the whole view on
 * work the user is watching somewhere else. */
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
                    <!-- WHICH PORTS THIS PAGE IS NOT ABOUT. Two different things are called "ports" here: sending
                         one out to the public internet (this view) and mirroring one onto the localhost of the
                         computer on your desk (Devices). Somebody whose dev server is missing from
                         localhost:3000 reads the word in the index, arrives here, finds their port listed and
                         apparently healthy, and leaves no wiser: the row was right, it was just answering a
                         different question. One sentence is cheaper than the hunt. -->
                    <span class="mt-2 block text-xs text-muted">
                        Looking for a port on your own <b>localhost</b> instead? That is desktop sync mirroring it onto your machine: Devices says
                        which ports made it, and which one another sandbox got to first.
                    </span>
                </InfoHint>
            </template>

            <!-- The scan already knows not to say "nothing is listening" before it has looked, but what it did
                 instead was say nothing at all, and a group whose body is empty reads as the same answer with
                 less confidence. The rows that are coming stand in: a port number's block, the name on the
                 title line, what it is for underneath, and the Preview button. -->
            <div v-if="isLoading && outline" role="status" aria-busy="true">
                <span class="sr-only">Scanning for listening ports…</span>
                <SkeletonRows :rows="3" density="compact" description control />
            </div>

            <div v-else-if="!isLoading && workspacePorts.length === 0" class="flex flex-col items-center gap-2 py-10 text-center">
                <Icon name="desktop" class="text-2xl text-subtle" />
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

        <!-- The sandbox's own machinery: visible for transparency, muted because nobody previews it.
             Forwarding stays possible (it's explicitly gated anyway), just de-emphasized. The hint is here
             because "what are these and did I start them?" is the question this whole section provokes, and
             the honest answer (no, they came with the box) is what makes it safe to ignore. -->
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
