<script setup lang="ts">
import { Button, ui, CopyButton, Icon, InfoHint, Notice, noticeOf, StatusBadge } from "@intentic/extension-ui";
import { ref } from "vue";
import { useShares } from "./useShares";

/* SHARED CONVERSATIONS: the owner's complete picture of which of their chats a stranger can read.
 *
 * Its own section above the published files, on the same reasoning that makes the file list what it is: the
 * outbox has no auth in front of it, so nothing about what is exposed may be a surprise. A conversation is the
 * most sensitive thing this workspace can publish, and it is also the one thing the file list could not
 * describe: a page and a folder of pictures say nothing about which chat they came from, how much of it
 * travelled, or when the snapshot was taken. Those three facts are the row.
 *
 * `sharedAt` is the load-bearing one, because a share is FROZEN: the date is not decoration, it is the line
 * between what a recipient can see and what is still private. Update moves it; nothing else does. */

const { shares, error, isLoading, update, remove } = useShares();

const busy = ref<string>();
const actionError = ref<string>();

const act = async (id: string, action: (id: string) => Promise<unknown>): Promise<void> => {
    actionError.value = undefined;
    busy.value = id;
    try {
        await action(id);
    } catch (caught) {
        actionError.value = caught instanceof Error ? caught.message : `The action failed.`;
    } finally {
        busy.value = undefined;
    }
};

const DAY = 86_400_000;
// Absolute once it is more than a day old, relative before that: the two ways this date gets read. "3h ago"
// answers "is this current?"; a date answers "which version of the conversation did they see?".
const when = (at: number): string => {
    const ago = Date.now() - at;
    if (ago < 3_600_000) {
        return `${Math.max(1, Math.round(ago / 60_000))}m ago`;
    }
    if (ago < DAY) {
        return `${Math.round(ago / 3_600_000)}h ago`;
    }
    return new Date(at).toLocaleDateString(undefined, { month: `short`, day: `numeric` });
};
</script>

<template>
    <section v-if="shares.length > 0 || isLoading">
        <div class="mb-2 flex items-center gap-2">
            <h3 :class="ui.sectionLabel()">Shared conversations</h3>
            <InfoHint label="Shared conversations">
                <span class="block text-sm font-medium text-content">Chats you've published</span>
                <span class="mt-1 block text-xs text-muted">
                    Each of these is a read-only page anyone with the link can open: no sign-in. It shows the conversation as it was when you shared
                    it, so anything said since stays private until you press <b>Update</b>. Share a chat from its right-click menu in the chat list.
                </span>
            </InfoHint>
            <StatusBadge v-if="shares.length > 0" variant="warning" :label="`${shares.length} public`" size="xs" />
        </div>

        <Notice v-if="actionError" :of="noticeOf(actionError)" class="mb-2" />
        <Notice v-else-if="error" :of="noticeOf(error)" class="mb-2" />

        <div v-if="shares.length > 0" class="rounded-lg border border-line bg-card">
            <div class="flex flex-col divide-y divide-line-subtle">
                <div v-for="share in shares" :key="share.id" class="flex flex-col gap-1.5 px-4 py-2.5">
                    <div class="flex items-center gap-3">
                        <Icon name="comments" class="shrink-0 text-subtle" />
                        <div class="min-w-0 flex-1">
                            <p class="truncate text-xs font-medium text-content" :title="share.title">{{ share.title }}</p>
                            <!-- What is behind the link, in the order it is asked about: how current, how much,
                                 how deep. -->
                            <p class="truncate text-2xs text-subtle">
                                shared {{ when(share.sharedAt) }} · {{ share.messages }} message{{ share.messages === 1 ? `` : `s` }} ·
                                {{ share.detail === "messages" ? "messages only" : "with the agent's work" }}
                            </p>
                        </div>
                        <a
                            v-if="share.url"
                            :href="share.url"
                            target="_blank"
                            rel="noopener"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                            :aria-label="`Open ${share.title} in a new tab`"
                            v-tooltip.bottom="'Open in new tab'"
                        >
                            <Icon name="external-link" />
                        </a>
                        <CopyButton v-if="share.url" :text="share.url" label="Copy link" />
                        <!-- Update, not "re-share": the link does not change, which is the whole point of
                             having it: it is already in somebody's messages. -->
                        <Button
                            label="Update"
                            size="small"
                            severity="secondary"
                            :disabled="busy !== undefined"
                            v-tooltip.bottom="'Publish everything said since you shared it'"
                            @click="act(share.id, update.mutateAsync)"
                        >
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <Button
                            label="Stop sharing"
                            size="small"
                            severity="secondary"
                            :disabled="busy !== undefined"
                            @click="act(share.id, remove.mutateAsync)"
                        >
                            <template #icon><Icon name="trash" /></template>
                        </Button>
                    </div>
                    <span v-if="share.url" class="truncate font-mono text-2xs text-subtle" :title="share.url">{{ share.url }}</span>
                    <!-- A sandbox with no tunnel has nowhere to publish to, so the page exists and nothing can
                         reach it. Worth saying on the row rather than leaving a share that looks fine. -->
                    <span v-else class="text-2xs text-danger">This sandbox has no public address, so this page can't be reached.</span>
                </div>
            </div>
        </div>
    </section>
</template>
