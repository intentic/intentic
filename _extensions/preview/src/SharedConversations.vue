<script setup lang="ts">
import { Await, Button, CopyButton, formatDayMonth, Icon, InfoHint, Notice, noticeOf, Row, RowGroup, Section } from "@intentic/extension-ui";
import { ref } from "vue";
import { useShares } from "./useShares";
import { t } from "./i18n.js";

// Owner's complete picture of which chats a stranger can read: how current the snapshot is, how much travelled, and how
// deep. `sharedAt` marks the freeze point; only Update moves it, so it is the line between what's public and what's
// still private.

const { loaded, update, remove } = useShares();

const busy = ref<string>();
const actionError = ref<string>();

const act = async (id: string, action: (id: string) => Promise<unknown>): Promise<void> => {
    actionError.value = undefined;
    busy.value = id;
    try {
        await action(id);
    } catch (caught) {
        actionError.value = caught instanceof Error ? caught.message : t(`common.actionFailed`);
    } finally {
        busy.value = undefined;
    }
};

const DAY = 86_400_000;
// Relative under a day old, absolute after: relative says how current, a date says which version was seen.
const when = (at: number): string => {
    const ago = Date.now() - at;
    if (ago < 3_600_000) {
        return t(`sharedConversations.minutesAgo`, { n: Math.max(1, Math.round(ago / 60_000)) });
    }
    if (ago < DAY) {
        return t(`sharedConversations.hoursAgo`, { n: Math.round(ago / 3_600_000) });
    }
    // Through the kit, not `toLocaleDateString` directly: the kit's formatters follow the language the app is in and
    // re-render when it changes, which a formatter built here does not.
    return formatDayMonth(at);
};
</script>

<template>
    <!-- Remembered as it was: nothing, when nobody has shared anything (so no header flashes), or its rows (so they do not
         pop in late). No fallback of its own; until it has been seen once, the page's wait stands for it. -->
    <Await :of="loaded" imprint="preview.shared-conversations">
        <template #default="{ data: shares, refreshError }">
            <Section v-if="shares.length > 0" :label="t(`sharedConversations.sharedConversations`)" :heading="3">
                <template #info>
                    <InfoHint :label="t(`sharedConversations.sharedConversations`)">
                        <span class="block text-sm font-medium text-content">{{ t(`sharedConversations.chatsYouvePublished`) }}</span>
                        <span class="mt-1 block text-xs text-muted">
                            {{ t(`sharedConversations.eachReadOnlyPage`) }} <b>{{ t(`sharedConversations.update`) }}</b
                            >. Share a chat from its right-click menu in the chat list.
                        </span>
                    </InfoHint>
                </template>

                <Notice v-if="actionError" :of="noticeOf(actionError)" class="mb-2" />
                <Notice v-else-if="refreshError" :of="noticeOf(refreshError)" class="mb-2" />

                <!-- The kit's rows, at the height every other list in the shell has; the address each one is published at is a line of
                     its own under the name, since it is what a reader copies and checks. -->
                <RowGroup>
                    <Row
                        v-for="share in shares"
                        :key="share.id"
                        icon="comments"
                        :title="share.title"
                        :description="
                            t(
                                `sharedConversations.summary`,
                                {
                                    when: when(share.sharedAt),
                                    count: share.messages,
                                    detail: share.detail === `messages` ? t(`sharedConversations.messagesOnly`) : t(`sharedConversations.withAgentWork`),
                                },
                                share.messages,
                            )
                        "
                        indent
                    >
                        <template #control>
                            <a
                                v-if="share.url"
                                :href="share.url"
                                target="_blank"
                                rel="noopener"
                                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                                :aria-label="t(`sharedConversations.openInNewTab`, { title: share.title })"
                                v-tooltip.bottom="t(`common.newTab`)"
                            >
                                <Icon name="external-link" />
                            </a>
                            <CopyButton v-if="share.url" :text="share.url" :label="t(`sharedConversations.copyLink`)" />
                            <!-- Update, not re-share: the link stays the same, since it's already in someone's messages. -->
                            <Button
                                :label="t(`sharedConversations.update`)"
                                size="small"
                                tier="boring"
                                :disabled="busy !== undefined"
                                v-tooltip.bottom="{ title: t(`sharedConversations.publishLatest`), note: t(`sharedConversations.linkStaysSame`) }"
                                @click="act(share.id, update.mutateAsync)"
                            >
                                <template #icon><Icon name="refresh" /></template>
                            </Button>
                            <Button
                                :label="t(`sharedConversations.stopSharing`)"
                                size="small"
                                tier="quiet"
                                tone="danger"
                                :disabled="busy !== undefined"
                                @click="act(share.id, remove.mutateAsync)"
                            >
                                <template #icon><Icon name="trash" /></template>
                            </Button>
                        </template>
                        <template #below>
                            <span v-if="share.url" class="block truncate font-mono text-2xs text-subtle" v-tooltip.bottom.overflow="share.url">{{
                                share.url
                            }}</span>
                            <!-- No tunnel means the page exists but nothing can reach it; worth flagging instead of looking fine. -->
                            <span v-else class="block text-2xs text-danger">{{ t(`sharedConversations.sandboxNoPublicAddress`) }}</span>
                        </template>
                    </Row>
                </RowGroup>
            </Section>
        </template>
    </Await>
</template>
