<script setup lang="ts">
import type { DraftStatus, DraftSummary } from "@intentic-app/api-contract";
import { Card, cmp, Page, StatusBadge, type StatusVariant } from "@intentic-app/ui";
import Button from "primevue/button";
import { ref } from "vue";
import { useDrafts } from "../composables/extensions/useDrafts";

/* Drafts: the approval inbox for posts the agent proposed during its scheduled work. The agent writes one JSON
 * file per draft into .intentic/drafts/ (taught by the daemon's drafts skill); this page is the owner's
 * approve / edit-date / reject side. Approving hands the draft to the "Publish approved drafts" automation,
 * which posts it through the platform skills once its scheduledAt is due. There is no create dialog here —
 * drafts originate with the agent, never the UI. */

const { drafts, invalid, error: listError, save, remove } = useDrafts();
const actionError = ref<string | null>(null);

const STATUS_VARIANT: Record<DraftStatus, StatusVariant> = {
    proposed: `warning`,
    approved: `info`,
    posting: `info`,
    posted: `success`,
    failed: `danger`,
};

// A datetime-local input works in the browser's timezone; the draft stores epoch ms. The agent is told to bake
// an explicit UTC offset into scheduledAt, so both ends agree on the instant — only the displayed wall-clock
// differs (the same tz caveat as the automations "next run" display).
const pad = (n: number): string => String(n).padStart(2, `0`);
// Empty when the agent proposed no date — the datetime-local shows blank and the owner picks one.
const toLocalInput = (ms?: number): string => {
    if (ms === undefined) {
        return ``;
    }
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const formatAt = (ms: number): string => new Date(ms).toLocaleString();

// Approve / retry / reschedule are all a re-post of the whole file with one field changed (the daemon upserts
// by id). Errors surface in the top strip; the query refetch reconciles the row.
const patch = async (draft: DraftSummary, changes: Partial<DraftSummary>): Promise<void> => {
    actionError.value = null;
    try {
        await save.mutateAsync({ ...draft, ...changes });
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not update the draft.`;
    }
};

const reschedule = (draft: DraftSummary, value: string): void => {
    const ms = new Date(value).getTime();
    if (!Number.isNaN(ms)) {
        void patch(draft, { scheduledAt: ms });
    }
};

const removeDraft = async (id: string): Promise<void> => {
    actionError.value = null;
    try {
        await remove.mutateAsync(id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not remove the draft.`;
    }
};
</script>

<template>
    <Page>
        <header class="mb-6">
            <h1 class="text-2xl font-semibold">Drafts</h1>
            <p class="mt-1 text-sm text-muted">
                Posts your agent prepared for approval. Approve one to queue it — the "Publish approved drafts" automation posts it on its scheduled
                date through the matching platform connector. Reject to discard.
            </p>
        </header>

        <div v-if="actionError ?? listError" :class="cmp.alertDanger('mb-3')">
            {{ actionError ?? listError }}
        </div>
        <div v-if="invalid.length > 0" :class="cmp.alertWarning('mb-3')">
            <Icon name="exclamation-triangle" class="mr-1.5" />{{ invalid.length }} draft file{{ invalid.length === 1 ? "" : "s" }} couldn't be read
            and won't post: <span class="font-mono">{{ invalid.join(", ") }}</span>
        </div>

        <!-- The section only exists once the agent has proposed a draft; an empty queue shows nothing here (and
             hides its rail tile). The invalid warning above stays, since it's actionable. -->
        <Card v-if="drafts.length > 0" class="flex flex-col gap-3">
            <div class="flex items-center gap-2.5">
                <Icon name="send" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">Pending posts</h2>
                    <p class="text-xs text-muted">Drafts live in your sandbox until they post — no platform draft system is used.</p>
                </div>
            </div>

            <div class="flex flex-col gap-2">
                <div v-for="draft in drafts" :key="draft.id" class="rounded-lg border border-line bg-canvas px-3 py-2">
                    <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                                <span class="rounded bg-overlay px-1.5 py-0.5 text-2xs font-medium capitalize text-content">{{
                                    draft.platform
                                }}</span>
                                <span v-if="draft.target" class="truncate rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">{{
                                    draft.target
                                }}</span>
                                <StatusBadge
                                    :variant="STATUS_VARIANT[draft.status]"
                                    :label="draft.status"
                                    size="xs"
                                    v-tooltip.top="draft.status === 'failed' ? draft.error : undefined"
                                />
                                <span
                                    v-if="draft.media && draft.media.length > 0"
                                    class="text-2xs text-subtle"
                                    v-tooltip.top="draft.media.join(', ')"
                                >
                                    <Icon name="paperclip" class="text-2xs" />{{ draft.media.length }}
                                </span>
                            </div>
                            <p v-if="draft.title" class="mt-1 truncate text-xs font-medium text-content">{{ draft.title }}</p>
                            <p class="mt-0.5 whitespace-pre-wrap wrap-break-word text-2xs text-subtle line-clamp-3">{{ draft.content }}</p>
                        </div>
                        <div class="flex shrink-0 flex-col items-end gap-2">
                            <!-- Reschedule: enabled until the draft is handed to the publisher (posting) or already out (posted). -->
                            <input
                                type="datetime-local"
                                :value="toLocalInput(draft.scheduledAt)"
                                :disabled="draft.status === 'posting' || draft.status === 'posted'"
                                :class="cmp.input('text-2xs px-2 py-1')"
                                class="disabled:opacity-50"
                                :aria-label="`Scheduled time for ${draft.id}`"
                                @change="reschedule(draft, ($event.target as HTMLInputElement).value)"
                            />
                            <div class="flex items-center gap-2">
                                <span v-if="draft.status === 'posted' && draft.postedAt" class="text-2xs text-subtle"
                                    >posted {{ formatAt(draft.postedAt) }}</span
                                >
                                <Button
                                    v-if="draft.status === 'proposed'"
                                    label="Approve"
                                    size="small"
                                    :disabled="save.isPending.value"
                                    @click="patch(draft, { status: 'approved' })"
                                >
                                    <template #icon><Icon name="check" /></template>
                                </Button>
                                <Button
                                    v-else-if="draft.status === 'failed'"
                                    label="Retry"
                                    size="small"
                                    severity="secondary"
                                    :disabled="save.isPending.value"
                                    @click="patch(draft, { status: 'approved' })"
                                >
                                    <template #icon><Icon name="refresh" /></template>
                                </Button>
                                <button
                                    type="button"
                                    class="text-muted hover:text-danger disabled:opacity-40"
                                    :disabled="draft.status === 'posting'"
                                    :aria-label="`Delete ${draft.id}`"
                                    v-tooltip.top="draft.status === 'posting' ? 'Posting…' : 'Reject'"
                                    @click="removeDraft(draft.id)"
                                >
                                    <Icon name="trash" class="text-sm" />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Card>
    </Page>
</template>
