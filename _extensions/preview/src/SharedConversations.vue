<script setup lang="ts">
import { Button, ui, CopyButton, Icon, InfoHint, Notice, noticeOf, StatusBadge } from "@intentic/extension-ui";
import { ref } from "vue";
import { useShares } from "./useShares";
import { t } from "./i18n.js";

// Owner's complete picture of which chats a stranger can read: how current the snapshot is, how much travelled, and how
// deep. `sharedAt` marks the freeze point; only Update moves it, so it is the line between what's public and what's
// still private.

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
// Relative under a day old, absolute after: relative says how current, a date says which version was seen.
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
            <h3 :class="ui.sectionLabel()">{{ t(`sharedConversations.sharedConversations`) }}</h3>
            <InfoHint :label="t(`sharedConversations.sharedConversations`)">
                <span class="block text-sm font-medium text-content">{{ t(`sharedConversations.chatsYouvePublished`) }}</span>
                <span class="mt-1 block text-xs text-muted">
                    {{ t(`sharedConversations.eachReadOnlyPage`) }} <b>{{ t(`sharedConversations.update`) }}</b
                    >. Share a chat from its right-click menu in the chat list.
                </span>
            </InfoHint>
            <StatusBadge v-if="shares.length > 0" variant="warning" :label="t(`sharedConversations.public`, { count: shares.length })" size="xs" />
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
                            <!-- Order matters: how current, how much, how deep. -->
                            <p class="truncate text-2xs text-subtle">
                                {{
                                    t(
                                        `sharedConversations.summary`,
                                        {
                                            when: when(share.sharedAt),
                                            count: share.messages,
                                            detail:
                                                share.detail === `messages`
                                                    ? t(`sharedConversations.messagesOnly`)
                                                    : t(`sharedConversations.withAgentWork`),
                                        },
                                        share.messages,
                                    )
                                }}
                            </p>
                        </div>
                        <a
                            v-if="share.url"
                            :href="share.url"
                            target="_blank"
                            rel="noopener"
                            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                            :aria-label="t(`sharedConversations.openInNewTab`, { title: share.title })"
                            v-tooltip.bottom="t(`sharedConversations.openInNewTab2`)"
                        >
                            <Icon name="external-link" />
                        </a>
                        <CopyButton v-if="share.url" :text="share.url" :label="t(`sharedConversations.copyLink`)" />
                        <!-- Update, not re-share: the link stays the same, since it's already in someone's messages. -->
                        <Button
                            :label="t(`sharedConversations.update`)"
                            size="small"
                            severity="secondary"
                            :disabled="busy !== undefined"
                            v-tooltip.bottom="t(`sharedConversations.publishEverythingSaidSince`)"
                            @click="act(share.id, update.mutateAsync)"
                        >
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <Button
                            :label="t(`sharedConversations.stopSharing`)"
                            size="small"
                            severity="secondary"
                            :disabled="busy !== undefined"
                            @click="act(share.id, remove.mutateAsync)"
                        >
                            <template #icon><Icon name="trash" /></template>
                        </Button>
                    </div>
                    <span v-if="share.url" class="truncate font-mono text-2xs text-subtle" :title="share.url">{{ share.url }}</span>
                    <!-- No tunnel means the page exists but nothing can reach it; worth flagging instead of looking fine. -->
                    <span v-else class="text-2xs text-danger">{{ t(`sharedConversations.sandboxNoPublicAddress`) }}</span>
                </div>
            </div>
        </div>
    </section>
</template>
