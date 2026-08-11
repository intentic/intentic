<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary, ExtensionUpdatePolicy } from "@intentic/sandbox-contract";
import { timeAgo } from "@intentic/ui";
import { cmp, Segmented, StatusBadge } from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref, watch } from "vue";
import { startAgent } from "../../composables/agents/agentActions";
import { useAgents } from "../../composables/agents/useAgents";
import { useExtensions } from "../../composables/extensions/useExtensions";
import { errorMessage } from "../../composables/useAsyncAction";
import { reloadExtensions } from "../../extension-host/useExtensionHost";
import { router } from "../../router";
import { updateBrief } from "./extensionBrief";

/* THE UPDATE STORY of one git-installed extension, below its row's fold — everything between "the registry
 * lists a newer commit" and "this browser runs it".
 *
 * The card leads with whatever demands the most: an advisory (its registry blocked it), then an unhealthy
 * update (came up wrong after a swap), then the update offer itself. The offer is a TWO-CLICK shape on
 * purpose: the first click stages the offered commit and renders the powers diff — the mechanical answer to
 * "what would I be approving" — and only the second click, now labelled by what the diff found ("Update" when
 * nothing grew, "Approve new powers & update" when something did), performs the transaction. Nothing here
 * auto-applies; the unattended rungs live in the policy control at the bottom, per extension, owner-set.
 *
 * Reverting is ordinary and visible whenever a previous version is kept, not only when something is on fire —
 * "the last update made it worse" needs no failing health probe to be true. */

const { extension } = defineProps<{ extension: ExtensionSummary }>();

const { previewUpdate, applyUpdate, revertUpdate, setUpdatePolicy } = useExtensions();

const update = computed(() => extension.update);
const identity = computed(() => extensionIdOf(extension.manifest));
const short = (ref_: string): string => ref_.slice(0, 7);

const busy = ref(false);
const failure = ref<string>();

// The staged read behind the first click. Cleared whenever the offer it describes changes.
const preview = ref<Awaited<ReturnType<typeof previewUpdate>>>();
watch(
    () => update.value?.ref,
    () => {
        preview.value = undefined;
        failure.value = undefined;
    },
);

const act = async (action: () => Promise<void>): Promise<void> => {
    if (busy.value) {
        return;
    }
    busy.value = true;
    failure.value = undefined;
    try {
        await action();
    } catch (error) {
        failure.value = errorMessage(error, `That didn't work.`);
    } finally {
        busy.value = false;
    }
};

const stage = (): Promise<void> =>
    act(async () => {
        preview.value = await previewUpdate(extension.id);
    });

// Applied, then the host runs again so THIS browser finishes on the new code — the same reconcile the tab's
// toggle performs. A pending image rebuild is reported, not implied away.
const rebuildNote = ref(false);
const apply = (): Promise<void> =>
    act(async () => {
        const applied = await applyUpdate(extension.id, preview.value?.ref);
        rebuildNote.value = applied.rebuildNeeded === true;
        preview.value = undefined;
        await reloadExtensions();
    });

const revert = (): Promise<void> =>
    act(async () => {
        await revertUpdate(extension.id);
        await reloadExtensions();
    });

// The agent's diff-read: link the finished one when the agent-prepared policy already ran it, offer to start
// it otherwise. An unregistered conversation still has a route — the chat screen resolves it by id.
const openReview = (conversationId: string): void => {
    const { agentById, open } = useAgents();
    const agent = agentById(conversationId);
    if (agent !== undefined) {
        open(agent);
    } else {
        void router.push(`/agents/${encodeURIComponent(conversationId)}`);
    }
};
const readDiff = (): void => {
    const offer = update.value;
    if (offer === undefined) {
        return;
    }
    startAgent(
        updateBrief({
            label: identity.value,
            url: offer.url,
            fromRef: extension.commit,
            toRef: offer.ref,
            path: offer.path ?? ``,
        }),
    );
};

// The confirm button says what the click now means: an update whose powers grew is an approval, not a refresh.
const confirmLabel = computed(() =>
    preview.value !== undefined && preview.value.powers.added.length > 0 ? `Approve new powers & update` : `Update`,
);

const policy = computed<ExtensionUpdatePolicy>(() => extension.updatePolicy ?? { updates: `notify`, advisories: `auto-disable` });
const POLICY_CAPTIONS: Record<ExtensionUpdatePolicy["updates"], string> = {
    notify: `New releases badge this row and wait for you.`,
    agent: `Your agent reads the diff the moment a release is listed — you open a finished review and decide.`,
    auto: `A human-verified release whose powers didn't grow applies unattended, health-watched, auto-reverted if it comes up wrong. Anything less falls back to notify.`,
};
const setPolicy = (updates: ExtensionUpdatePolicy["updates"]): Promise<void> => act(() => setUpdatePolicy(extension.id, { updates }));
const setAdvisories = (autoDisable: boolean): Promise<void> =>
    act(() => setUpdatePolicy(extension.id, { advisories: autoDisable ? `auto-disable` : `notify` }));
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- The alarm, when there is one. It stays until the registry unblocks the listing — an advisory is a
             standing fact about the code, not a notification to swipe away. -->
        <div v-if="extension.advisory" class="rounded border border-danger/40 bg-danger/5 p-2.5">
            <p class="text-xs font-medium text-danger">Blocked by its registry</p>
            <p class="mt-0.5 text-2xs text-muted">{{ extension.advisory.reason }}</p>
            <p class="mt-1 text-2xs text-subtle">
                {{
                    extension.advisory.autoDisabled
                        ? `It was switched off automatically — the switch above turns it back on if you disagree.`
                        : extension.enabled
                          ? `It is still running because its advisory policy is set to notify — the switch above is the way out.`
                          : `It is switched off.`
                }}
            </p>
        </div>

        <!-- The after-the-click watch. Healthy is silent; only a verdict worth acting on takes space. -->
        <div v-if="extension.health?.state === `unhealthy`" class="rounded border border-warning/40 bg-warning/5 p-2.5">
            <p class="text-xs font-medium text-warning">
                {{ extension.health?.autoReverted ? `An update came up wrong and was rolled back` : `This update isn't healthy` }}
            </p>
            <p class="mt-0.5 text-2xs text-muted">{{ extension.health?.detail }}</p>
            <div v-if="extension.health?.autoReverted !== true && extension.previous" class="mt-1.5">
                <Button size="small" severity="warn" outlined :label="`Revert to ${short(extension.previous.ref)}`" :loading="busy" @click="revert" />
            </div>
        </div>

        <!-- The offer. -->
        <div v-if="update" class="rounded border border-line p-2.5">
            <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs text-content">
                    <span class="font-medium">v{{ extension.manifest.version }}</span>
                    <span class="text-subtle"> → </span>
                    <span class="font-medium">{{ update.version !== undefined ? `v${update.version}` : short(update.ref) }}</span>
                </span>
                <StatusBadge v-if="update.securityFix" variant="danger" label="security fix" size="xs" />
                <StatusBadge
                    :variant="update.trust === `verified` ? `success` : `neutral`"
                    :label="update.trust === `verified` ? `verified` : `listed — no human review`"
                    size="xs"
                />
                <span class="text-2xs text-subtle">listed {{ timeAgo(Date.parse(update.at)) }}</span>
            </div>
            <!-- Why the unattended rung didn't take it: the reason the click is the owner's. -->
            <p v-if="update.needsReview" class="mt-1.5 text-2xs text-warning">Held for your review: {{ update.needsReview }}.</p>

            <!-- The staged read: what this click would approve, mechanically. -->
            <div v-if="preview" class="mt-2 flex flex-col gap-1.5 border-t border-line pt-2">
                <p v-if="!preview.compatible" class="text-2xs text-warning">
                    It asks for app {{ preview.engines }} — this app can't run it yet, so updating would leave it inactive until the app updates.
                </p>
                <template v-if="preview.powers.added.length > 0">
                    <p class="text-2xs font-medium text-warning">New powers this version asks for:</p>
                    <ul class="flex flex-col gap-0.5">
                        <li v-for="power in preview.powers.added" :key="power" class="text-2xs text-content">+ {{ power }}</li>
                    </ul>
                </template>
                <p v-else class="text-2xs text-success">Same powers as the installed version — nothing new to approve.</p>
                <ul v-if="preview.powers.removed.length > 0" class="flex flex-col gap-0.5">
                    <li v-for="power in preview.powers.removed" :key="power" class="text-2xs text-subtle">− {{ power }}</li>
                </ul>
                <p v-if="preview.powers.unchanged.length > 0" class="text-2xs text-subtle">{{ preview.powers.unchanged.length }} unchanged.</p>
            </div>

            <div class="mt-2 flex flex-wrap items-center gap-2">
                <Button v-if="!preview" size="small" outlined :loading="busy" label="See what changed…" @click="stage" />
                <Button
                    v-else
                    size="small"
                    :severity="preview.powers.added.length > 0 ? `warn` : undefined"
                    :loading="busy"
                    :label="confirmLabel"
                    @click="apply"
                />
                <button v-if="update.review" type="button" :class="cmp.linkButton(`text-2xs`)" @click="openReview(update.review.conversationId)">
                    Your agent already read this diff — open its review
                </button>
                <button v-else type="button" :class="cmp.linkButton(`text-2xs`)" @click="readDiff">Have an agent read the diff first</button>
            </div>
        </div>

        <p v-if="rebuildNote" class="text-2xs text-warning">
            This update extends the sandbox image — a one-time rebuild is needed. Open the Sandbox page's Environment card for the command.
        </p>

        <!-- The way back, ordinary and visible: "the last update made it worse" needs no failing probe. -->
        <p v-if="extension.previous && extension.health?.state !== `unhealthy`" class="text-2xs text-subtle">
            The previous version is kept{{ extension.previous.version !== undefined ? ` (v${extension.previous.version})` : `` }}.
            <button type="button" :class="cmp.linkButton(`text-2xs`)" :disabled="busy" @click="revert">
                Revert to {{ short(extension.previous.ref) }}
            </button>
        </p>

        <!-- The standing answer: what happens the next time the registry lists a release of THIS extension. -->
        <div>
            <p :class="cmp.sectionLabel(`mb-1.5 text-2xs`)">When a new release is listed</p>
            <Segmented
                :model-value="policy.updates"
                :options="[
                    { label: `Notify`, value: `notify` },
                    { label: `Agent-prepared`, value: `agent` },
                    { label: `Auto`, value: `auto` },
                ]"
                @update:model-value="(value: string) => setPolicy(value as ExtensionUpdatePolicy[`updates`])"
            />
            <p class="mt-1 text-2xs text-subtle">{{ POLICY_CAPTIONS[policy.updates] }}</p>
            <label class="mt-1.5 flex items-center gap-1.5 text-2xs text-muted">
                <input
                    type="checkbox"
                    :checked="policy.advisories === `auto-disable`"
                    :disabled="busy"
                    @change="(event) => setAdvisories((event.target as HTMLInputElement).checked)"
                />
                Switch it off automatically if its registry marks it malicious or broken
            </label>
        </div>

        <p v-if="failure" class="text-2xs text-danger">{{ failure }}</p>
    </div>
</template>
