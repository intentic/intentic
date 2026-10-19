<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { Button, Notice, StatusBadge, timeAgo, toneTint, ui } from "@intentic/ui";
import { computed, watch } from "vue";
import ActionLink from "../../../components/ActionLink.vue";
import { startAgent } from "../../../models/fleet/agentActions";
import { useAgents } from "../../../models/fleet/useAgents";
import { useOperation } from "../../../workbench/operations/operations";
import { navigation } from "../../../workbench/navigation/navigation";
import { updateBrief } from "../../../models/sandbox/extensionBrief";
import { drawerScope, extensionBusy, latestFailure } from "./extensionWork";
import { useExtensionUpdates } from "./useExtensionUpdates";
import WaitProgress from "../../../components/WaitProgress.vue";
import { useWaitClock } from "../../../components/useWaitClock";
import { useT } from "@intentic/ui/i18n";

// What an open row says about its installed version before anything else, so it leads the drawer: a registry advisory,
// an update that came up wrong, then the update on offer. The offer is named for the row's `update` pill, so the pill
// and the thing to press are one idea, and it is two clicks on purpose: Review stages the powers diff, then the confirm
// is labelled by what that found. The standing policy lives in the drawer's Updates section, not here.
//
// Each step is kept in the operations ledger under the extension's id (extensionWork.ts), not in this component: it is
// drawn inside the row's drawer, so collapsing the row unmounts it while the daemon fetches and builds the new code, and
// reopening it has to show the apply still running, and then how it ended, rather than offer it again.

const t = useT();

const { extension, anchor } = defineProps<{
    extension: ExtensionSummary;
    /** The offer box's id, so the row's pill can bring the reader straight to it. */
    anchor: string;
}>();

const { previewUpdate, apply: applyUpdate, revert: revertUpdate } = useExtensionUpdates();
const at = (act: string): string => `${drawerScope(extension.id)}/update/${act}`;
// The staged read behind the first click: what the confirm would approve.
const staging = useOperation<Awaited<ReturnType<typeof previewUpdate>>>(() => at(`preview`));
const applying = useOperation<Awaited<ReturnType<typeof applyUpdate>>>(() => at(`apply`));
const reverting = useOperation(() => at(`revert`));
// Anything under way on this extension, from this drawer, the row's own switch or Browse: one at a time.
const busy = computed(() => extensionBusy(extension.id, extensionIdOf(extension.manifest)));
const notice = computed(() => latestFailure([staging.operation.value, applying.operation.value, reverting.operation.value]));

const offer = computed(() => extension.update);
const unhealthy = computed(() => (extension.health?.state === `unhealthy` ? extension.health : undefined));
const short = (ref_: string): string => ref_.slice(0, 7);

const preview = staging.value;
// Dropped whenever the offer it describes changes, with any failure said about it. A finished apply stays: the offer
// it took is gone by then, and what it reports (a rebuild still owed) outlives it.
watch(
    () => offer.value?.ref,
    () => {
        staging.dismiss();
        if (applying.failure.value !== undefined) {
            applying.dismiss();
        }
        reverting.dismiss();
    },
);

// A release can keep its version string and still be new code; the commit is then the only thing telling them apart.
const sameVersion = computed(() => offer.value?.version !== undefined && offer.value.version === extension.manifest.version);
const fromLabel = computed(() =>
    sameVersion.value ? `v${extension.manifest.version} · ${short(extension.commit)}` : `v${extension.manifest.version}`,
);
const toLabel = computed(() => {
    const current = offer.value;
    if (current === undefined) {
        return ``;
    }
    if (current.version === undefined) {
        return short(current.ref);
    }
    return sameVersion.value ? `v${current.version} · ${short(current.ref)}` : `v${current.version}`;
});

const added = computed(() => preview.value?.powers.added ?? []);
// The confirm is named for what it means: growing powers makes it an approval, not a refresh.
const confirmLabel = computed(() => {
    if (added.value.length > 0) {
        return t(`sandbox.extensionUpdateOffer.approvePowersUpdate`);
    }
    const current = offer.value;
    const target = current?.version === undefined || sameVersion.value ? short(current?.ref ?? ``) : `v${current.version}`;
    return t(`sandbox.extensionUpdateOffer.updateTo`, { version: target });
});

const failed = (): string => t(`sandbox.extensionUpdateOffer.didntWork`);

// A read of a staged clone; the drawer that asked is where its answer is drawn, so it raises no receipt of its own.
const stage = async (): Promise<void> => {
    if (busy.value) {
        return;
    }
    await staging.run({
        what: t(`sandbox.extensionUpdateOffer.reviewing`, { id: extension.id }),
        quiet: true,
        failed: failed(),
        task: () => previewUpdate(extension.id),
    });
};

// Applying reloads the host so this browser runs the new code (useExtensionUpdates). A pending image rebuild is
// reported, not implied away. The staged read is spent once the update lands, so it goes with the apply.
const apply = async (): Promise<void> => {
    if (busy.value) {
        return;
    }
    const target = preview.value?.ref;
    await applying.run({
        what: t(`sandbox.extensionUpdateOffer.updating`, { id: extension.id }),
        done: () => t(`sandbox.extensionUpdateOffer.updated`, { id: extension.id }),
        failed: failed(),
        task: async () => {
            const applied = await applyUpdate(extension.id, target);
            staging.dismiss();
            return applied;
        },
    });
};
const rebuildNote = computed(() => applying.value.value?.rebuildNeeded === true);

// Which of this offer's two steps is running, said beneath its held button with how long it has run: the review fetches
// the new code to compare, and the apply fetches and builds it, which on a big extension takes minutes.
const step = computed(() => {
    if (applying.busy.value) {
        return { at: applying.operation.value?.startedAt, what: t(`sandbox.extensionUpdateOffer.applyingWhat`) };
    }
    return staging.busy.value ? { at: staging.operation.value?.startedAt, what: t(`sandbox.extensionUpdateOffer.reviewingWhat`) } : undefined;
});
const stepWait = useWaitClock(() => step.value?.at);

const revert = async (): Promise<void> => {
    if (busy.value) {
        return;
    }
    await reverting.run({
        what: t(`sandbox.extensionUpdateOffer.reverting`, { id: extension.id }),
        done: () => t(`sandbox.extensionUpdateOffer.reverted`, { id: extension.id }),
        failed: failed(),
        task: () => revertUpdate(extension.id),
    });
};

// Links a finished agent diff-read when the policy already ran one, offers to start one otherwise; an unregistered
// conversation still resolves by id through the chat route.
const reviewAt = (conversationId: string): string => `/agents/${encodeURIComponent(conversationId)}`;
const openReview = (conversationId: string): void => {
    const { agentById, open } = useAgents();
    const agent = agentById(conversationId);
    if (agent !== undefined) {
        open(agent);
    } else {
        void navigation().push(reviewAt(conversationId));
    }
};
const readDiff = (): void => {
    const current = offer.value;
    if (current === undefined) {
        return;
    }
    startAgent(
        updateBrief({
            label: extensionIdOf(extension.manifest),
            url: current.url,
            fromRef: extension.commit,
            toRef: current.ref,
            path: current.path ?? ``,
        }),
    );
};

const advisoryState = computed(() => {
    if (extension.advisory?.autoDisabled === true) {
        return t(`sandbox.extensionUpdateOffer.switchedOffAutomaticallySwitch`);
    }
    return extension.enabled ? t(`sandbox.extensionUpdateOffer.stillRunningBecauseAdvisory`) : t(`sandbox.extensionUpdateOffer.switchedOff`);
});

// Renders nothing at all for the ordinary installed extension, so the drawer leads with its sections instead of a gap.
const shown = computed(
    () =>
        extension.advisory !== undefined ||
        unhealthy.value !== undefined ||
        offer.value !== undefined ||
        rebuildNote.value ||
        notice.value !== undefined,
);
</script>

<template>
    <div v-if="shown" class="flex flex-col gap-2.5">
        <!-- Stays until the registry unblocks the listing: an advisory is a standing fact, not a notice to dismiss. -->
        <Notice v-if="extension.advisory" tone="danger" size="sm">
            <span class="block font-medium">{{ t(`sandbox.extensionUpdateOffer.blockedByRegistry`) }}</span>
            <span class="mt-0.5 block text-content">{{ extension.advisory.reason }}</span>
            <span class="mt-1 block text-muted">{{ advisoryState }}</span>
        </Notice>

        <!-- Healthy is silent; only a verdict worth acting on takes space here. -->
        <Notice v-if="unhealthy" tone="warning" size="sm">
            <span class="block font-medium">
                {{
                    unhealthy.autoReverted ? t(`sandbox.extensionUpdateOffer.updateCameUpWrong`) : t(`sandbox.extensionUpdateOffer.updateIsntHealthy`)
                }}
            </span>
            <span v-if="unhealthy.detail" class="mt-0.5 block text-content">{{ unhealthy.detail }}</span>
            <template v-if="unhealthy.autoReverted !== true && extension.previous" #actions>
                <Button
                    size="small"
                    tone="warning"
                    :label="t(`sandbox.extensionUpdateOffer.revertTo`, { ref: short(extension.previous.ref) })"
                    :loading="busy"
                    @click="revert"
                >
                    <template #icon><Icon name="undo" /></template>
                </Button>
            </template>
        </Notice>

        <!-- The offer, under the same name as the row's pill. A security fix wears the danger tone the pill does. -->
        <div v-if="offer" :id="anchor" class="rounded-lg border px-3 py-2.5" :class="toneTint(offer.securityFix ? `danger` : `info`, `soft`)">
            <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <Icon
                    :name="offer.securityFix ? `shield` : `arrow-circle-up`"
                    class="shrink-0"
                    :class="offer.securityFix ? `text-danger` : `text-info`"
                    aria-hidden="true"
                />
                <span class="text-xs font-medium" :class="offer.securityFix ? `text-danger` : `text-content`">
                    {{
                        offer.securityFix
                            ? t(`sandbox.extensionUpdateOffer.securityUpdateAvailable`)
                            : t(`sandbox.extensionUpdateOffer.updateAvailable`)
                    }}
                </span>
                <span class="text-xs tabular-nums text-muted">
                    {{ fromLabel }} <span class="text-subtle">→</span> <span class="font-medium text-content">{{ toLabel }}</span>
                </span>
                <StatusBadge
                    :variant="offer.trust === `verified` ? `success` : `neutral`"
                    :label="
                        offer.trust === `verified`
                            ? t(`sandbox.extensionUpdateOffer.verified`)
                            : t(`sandbox.extensionUpdateOffer.listedNoHumanReview`)
                    "
                    size="xs"
                />
                <span class="text-2xs text-subtle">{{ t(`sandbox.extensionUpdateOffer.listed`, { at: timeAgo(Date.parse(offer.at)) }) }}</span>
            </div>
            <!-- Why the unattended rung didn't take it: the reason the click is the owner's. -->
            <p v-if="offer.needsReview" class="mt-1.5 text-2xs text-muted">
                {{ t(`sandbox.extensionUpdateOffer.heldReview`, { needsReview: offer.needsReview }) }}
            </p>

            <!-- The staged read: what the next click would approve, mechanically. -->
            <div v-if="preview" class="mt-2.5 flex flex-col gap-1.5 border-t border-line pt-2.5">
                <p v-if="!preview.compatible" class="text-2xs text-warning">
                    {{ t(`sandbox.extensionUpdateOffer.asksAppAppCant`, { engines: preview.engines }) }}
                </p>
                <template v-if="added.length > 0">
                    <p class="text-2xs font-medium text-warning">{{ t(`sandbox.extensionUpdateOffer.newPowersVersionAsks`) }}</p>
                    <ul class="flex flex-col gap-0.5">
                        <li v-for="power in added" :key="power" class="text-2xs text-content">+ {{ power }}</li>
                    </ul>
                </template>
                <p v-else class="text-2xs text-success">{{ t(`sandbox.extensionUpdateOffer.samePowersInstalledVersion`) }}</p>
                <ul v-if="preview.powers.removed.length > 0" class="flex flex-col gap-0.5">
                    <li v-for="power in preview.powers.removed" :key="power" class="text-2xs text-subtle">− {{ power }}</li>
                </ul>
                <p v-if="preview.powers.unchanged.length > 0" class="text-2xs text-subtle">
                    {{ t(`sandbox.extensionUpdateOffer.unchanged`, { count: preview.powers.unchanged.length }) }}
                </p>
            </div>

            <div class="mt-2.5 flex flex-wrap items-center gap-2">
                <Button v-if="!preview" size="small" :loading="busy" :label="t(`sandbox.extensionUpdateOffer.reviewUpdate`)" @click="stage" />
                <template v-else>
                    <Button size="small" :tone="added.length > 0 ? `warning` : undefined" :loading="busy" :label="confirmLabel" @click="apply" />
                    <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" :disabled="busy" @click="staging.dismiss()" />
                </template>
                <ActionLink
                    v-if="offer.review"
                    :to="reviewAt(offer.review.conversationId)"
                    :class="ui.textButton({ size: `xs` })"
                    @activate="openReview(offer.review.conversationId)"
                >
                    {{ t(`sandbox.extensionUpdateOffer.agentAlreadyReadDiff`) }}
                </ActionLink>
                <Button
                    v-else-if="!preview"
                    size="small"
                    tier="boring"
                    :label="t(`sandbox.extensionUpdateOffer.agentReadDiffFirst`)"
                    @click="readDiff"
                >
                    <template #icon><Icon name="sparkles" /></template>
                </Button>
            </div>
            <WaitProgress v-if="stepWait && step" :wait="stepWait" :what="step.what" class="mt-2.5" />
        </div>

        <Notice v-if="rebuildNote" tone="warning" size="sm">{{ t(`sandbox.extensionUpdateOffer.updateExtendsSandboxImage`) }}</Notice>
        <Notice v-if="notice" :of="notice" size="sm" />
    </div>
</template>
