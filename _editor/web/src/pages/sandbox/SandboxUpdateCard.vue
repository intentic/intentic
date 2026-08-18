<script setup lang="ts">
import { Card, Row, StatusBadge, useOsPreference } from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
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
 * it is wanted, which is precisely when there is no update to advertise.
 *
 * AND IT SPLITS THE OFFER IN TWO, because updating was never one kind of work. Downloading the new image and
 * rebuilding the environment recipe are the minutes, and the sandbox is up and serving through both of them;
 * the restart at the end is the seconds. This card used to quote the whole span as downtime — "a few minutes
 * and this page loses the sandbox" — which is an outage several times longer than the one that happens, on the
 * same card that asks you to weigh it against interrupting agents mid-turn.
 *
 * So: download now, apply when it suits. Once the host says the image is staged (info.staged, written by
 * `ic sandbox prepare`), the offer stops being an unbounded wait and becomes a bounded restart, and the card
 * says so. That sentence is the single largest change here; the button that produces it is the second. */

const { installed, latest, updateAvailable, updateNotes, moreUpdateNotes, breakingNotes, updateStaged, stagedBehind, info, serverManaged, slug } =
    useSandboxVersion();
const { cmdOs } = useOsPreference();

/* A BREAKING UPDATE MUST NOT LOOK ROUTINE. When the gap carries breaking notes the card changes character —
 * danger badge, the breaking lines first — and the update command stays behind one explicit click: consent to
 * a breaking change should be informed, and "informed" is not a list scrolled past on the way to a button.
 * Routine updates keep their one-step flow untouched; rollback is never gated, because it is the way OUT of a
 * breaking update that went badly. Acknowledgment is deliberately not persisted — a card seen again after a
 * reload asks again, which for something read once a fortnight is a feature, not friction. */
const breaking = computed(() => updateAvailable.value && breakingNotes.value.length > 0);
const acknowledged = ref(false);

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
        <Row
            flush
            :heading="2"
            :icon="breaking ? `exclamation-triangle` : updateAvailable ? `arrow-circle-up` : `history`"
            :tone="breaking ? `danger` : `default`"
            :title="
                breaking
                    ? `Update available — changes how things work`
                    : updateAvailable
                      ? updateStaged
                          ? `Update ready to apply`
                          : `Update available`
                      : `Sandbox image`
            "
        >
            <template #description>
                <template v-if="breaking">
                    This update removes or changes things you may rely on — read what changes below before taking it. Your files (in /work) are kept
                    either way, and you can roll back afterwards —
                    <a href="https://intentic.dev/docs/updates/" target="_blank" rel="noopener" class="underline hover:text-content"
                        >what updates never break</a
                    >.
                </template>
                <!-- The sentence this whole card was rebuilt around. A bounded half-minute is a completely
                     different decision from an unbounded "a few minutes", and until the host started reporting
                     what it had already downloaded there was no way to tell the two apart. -->
                <template v-else-if="updateAvailable && updateStaged">
                    It is already downloaded and built on the computer that runs this sandbox. Applying it restarts your sandbox for about half a
                    minute — your files (in /work) are kept.
                </template>
                <template v-else-if="updateAvailable">
                    A newer sandbox image has been released. Downloading it interrupts nothing — your sandbox keeps working until you apply it, and
                    your files (in /work) are kept.
                </template>
                <template v-else>
                    You are on the newest image for this channel. If the last update caused trouble, you can go back to the one before it.
                </template>
            </template>
            <template #meta>
                <StatusBadge v-if="updateAvailable && updateStaged && !breaking" variant="success" label="Downloaded" dot />
                <StatusBadge v-if="updateAvailable" :variant="breaking ? `danger` : `warning`" :label="`${installed ?? '?'} → ${latest}`" dot />
                <StatusBadge v-else-if="channel" variant="neutral" :label="channel" />
            </template>
        </Row>

        <!-- WHAT STOPS WORKING, before anything else on the card and never truncated: a warning that fell off
             the end of a capped list is a breaking update taken unwarned. Each line was written in the commit
             that made the break, telling the user what changes for them and what to do about it. -->
        <div v-if="breaking" class="flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-danger/10 p-3">
            <p class="text-xs font-medium text-danger">What changes</p>
            <ul class="flex flex-col gap-1">
                <li v-for="note in breakingNotes" :key="note" class="flex gap-2 text-2xs text-content">
                    <span class="mt-1.5 h-0.5 w-0.5 shrink-0 rounded-full bg-danger" />
                    <span>{{ note }}</span>
                </li>
            </ul>
        </div>

        <!-- WHAT YOU WOULD GET, above the warning about what it costs and above the button that does it. That
             order is the whole point of this section: this card asks the reader to weigh an update against
             interrupting work that is running right now, and until these lines existed it put the cost and the
             button on screen with nothing at all on the other side of the scale.

             Written when each change shipped and published with its release, so it is the same text the
             changelog carries — not a second description written here. Absent whenever there is nothing to
             say (a release nobody outside the project would notice, a cold cache, no route to GitHub), and the
             card then reads exactly as it did before. -->
        <div v-if="updateAvailable && updateNotes.length > 0" class="flex flex-col gap-1.5 border-t border-line pt-3">
            <p class="text-xs font-medium text-content">What's new</p>
            <ul class="flex flex-col gap-1">
                <li v-for="note in updateNotes" :key="note" class="flex gap-2 text-2xs text-muted">
                    <span class="mt-1.5 h-0.5 w-0.5 shrink-0 rounded-full bg-primary-500" />
                    <span>{{ note }}</span>
                </li>
            </ul>
            <!-- The tail of a long gap, as a count rather than fifty more bullets — a sandbox nobody has
                 recreated in weeks would otherwise bury the rest of this page. -->
            <p v-if="moreUpdateNotes > 0" class="text-2xs text-subtle">
                …and {{ moreUpdateNotes }} more —
                <a href="https://intentic.dev/changelog/" target="_blank" rel="noopener" class="underline hover:text-content">read the changelog</a>
            </p>
        </div>

        <!-- The restart is what costs a turn, and it is now the only part that does — so the way out of this
             warning is no longer "come back later", it is the button above that downloads without restarting.
             Only offered where there is something to download: on a card showing nothing but a rollback, that
             sentence would be advice about work that does not exist. -->
        <p v-if="midTurn > 0" class="text-2xs text-warning">
            {{ midTurn === 1 ? `An agent is` : `${midTurn} agents are` }} mid-turn right now — restarting the sandbox interrupts
            {{ midTurn === 1 ? `its` : `their` }} work.
            <template v-if="updateAvailable && !updateStaged">
                Downloading it now costs {{ midTurn === 1 ? `it` : `them` }} nothing, and the restart can wait.
            </template>
            <template v-else>Wait for the fleet to settle, or continue if that is acceptable.</template>
        </p>

        <!-- A prepared update a newer release has overtaken. Rare, and worth a sentence anyway: applying now
             hands over the older one, and a card that stayed silent would be promising the newer. -->
        <p v-if="updateAvailable && stagedBehind" class="text-2xs text-muted">
            {{ stagedBehind }} is already downloaded here, but {{ latest }} has been released since. Updating now gives you {{ stagedBehind }} — or
            download the newer one first.
        </p>

        <template v-if="serverManaged">
            <p class="text-2xs text-subtle">
                This sandbox updates on the next <span class="font-mono">intentic deploy apply</span> against its host.
            </p>
        </template>
        <template v-else-if="slug">
            <!-- The acknowledgment gate: for a breaking update the command appears only after one explicit
                 click. Not a legal ritual — the point is that the reader's eyes crossed the list above before
                 the copy-paste reflex could fire. -->
            <template v-if="breaking && !acknowledged">
                <Button label="I've read what changes — show me the update" size="small" severity="secondary" @click="acknowledged = true" />
            </template>
            <!-- ONE OFFER WHEN THE IMAGE IS HERE, TWO WHEN IT IS NOT. The pair is not clutter: it is the
                 decision this card exists to put in front of someone, and until the download could be taken on
                 its own there was only ever the expensive half of it. The card already renders two blocks side
                 by side when a rollback is offered alongside an update, so the shape is the established one. -->
            <template v-else-if="updateAvailable && updateStaged">
                <p class="text-xs font-medium text-content">Apply it — this restarts your sandbox:</p>
                <HostRecreate :slug="slug" action="Update" ready />
            </template>
            <template v-else-if="updateAvailable">
                <p class="text-xs font-medium text-content">Download it now — nothing restarts until you say so:</p>
                <HostRecreate :slug="slug" action="Download" />
                <p class="text-xs font-medium text-content">Or do both now, downloading and restarting in one go:</p>
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
