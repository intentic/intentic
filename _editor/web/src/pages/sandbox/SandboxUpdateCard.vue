<script setup lang="ts">
import { Card, StatusBadge, useOsPreference } from "@intentic/ui";
import { computed } from "vue";
import HostRecreate from "../../components/HostRecreate.vue";
import { turnInFlight } from "../../composables/agents/agentStatus";
import { useAgents } from "../../composables/agents/useAgents";
import { useSandboxVersion } from "../../composables/sandbox/useSandboxVersion";

/* "Update available" — the non-blocking prompt on the /sandbox hub when a newer sandbox image has shipped. The
 * daemon reports installed vs latest on /info; the update runs on the host (the sandbox holds no host Docker
 * socket — its own engine is nested, so it can't recreate its own container), which is what HostRecreate is
 * for: a button in the desktop app, the copy-paste one-liner in a browser. A server-managed sandbox updates on
 * its host's next deploy, so it gets a note instead.
 *
 * THE CARD ALSO SHOWS WHEN THERE IS NO UPDATE, if there is somewhere to go BACK to. That is the change worth
 * naming: an update that turns out badly used to have no answer short of re-running the connect wizard, which
 * is a heavy thing to ask of someone whose sandbox just got worse. recreate.sh now records the image it
 * replaced, the daemon reports it, and the way back is one command — but only if it is visible at the moment
 * it is wanted, which is precisely when there is no update to advertise. */

const { installed, latest, updateAvailable, info, serverManaged, slug } = useSandboxVersion();
const { cmdOs } = useOsPreference();

/* Rollback is POSIX-only for now — recreate.ps1 has no -Rollback parameter (its header says why), so on a
 * Windows shell there is no command to hand over. Hidden rather than shown-and-broken: an offer that fails
 * when taken is worse than no offer, and this one would fail at the moment the user most needs it to work. */
const rollbackTo = computed(() => (cmdOs.value === `windows` ? undefined : info.value?.previousImage));
const channel = computed(() => info.value?.channel);

/* Recreating kills whatever the fleet is doing RIGHT NOW — resume-after-restart is off by default (it spends
 * the owner's own allowance), so the default cost of updating mid-run is the run. The card said "your files
 * are kept" and nothing about the forty-minute turn; this line is what makes updating mid-run a choice. */
const { fleet } = useAgents();
const midTurn = computed(() => fleet.value.filter(turnInFlight).length);
</script>

<template>
    <Card v-if="updateAvailable || rollbackTo" class="flex flex-col gap-4">
        <div class="flex items-start gap-2.5">
            <Icon :name="updateAvailable ? `arrow-circle-up` : `history`" class="mt-0.5 text-lg text-muted" />
            <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-3">
                    <h2 class="font-semibold leading-tight">{{ updateAvailable ? `Update available` : `Sandbox image` }}</h2>
                    <StatusBadge v-if="updateAvailable" variant="warning" :label="`${installed ?? '?'} → ${latest}`" dot />
                    <StatusBadge v-else-if="channel" variant="neutral" :label="channel" />
                </div>
                <p v-if="updateAvailable" class="text-2xs text-subtle">
                    A newer sandbox image has been released. Updating pulls it and recreates your sandbox — your files (in /work) are kept.
                </p>
                <p v-else class="text-2xs text-subtle">
                    You are on the newest image for this channel. If the last update caused trouble, you can go back to the one before it.
                </p>
            </div>
        </div>

        <p v-if="midTurn > 0" class="text-2xs text-warning">
            {{ midTurn === 1 ? `An agent is` : `${midTurn} agents are` }} mid-turn right now — recreating the sandbox interrupts
            {{ midTurn === 1 ? `its` : `their` }} work. Wait for the fleet to settle, or continue if that is acceptable.
        </p>

        <template v-if="serverManaged">
            <p class="text-2xs text-subtle">
                This sandbox updates on the next <span class="font-mono">intentic deploy apply</span> against its host.
            </p>
        </template>
        <template v-else-if="slug">
            <template v-if="updateAvailable">
                <p class="text-xs font-medium text-content">To update, recreate your sandbox on the new image:</p>
                <HostRecreate :slug="slug" action="Update" />
            </template>
            <!-- Offered alongside an available update too: "this one broke it, put it back" is exactly as
                 likely to be the reason someone opened this card as "give me the new one". -->
            <template v-if="rollbackTo">
                <p class="text-xs font-medium text-content">
                    Roll back to <span class="font-mono text-2xs">{{ rollbackTo }}</span
                    >:
                </p>
                <HostRecreate :slug="slug" action="Roll back" />
            </template>
        </template>
    </Card>
</template>
