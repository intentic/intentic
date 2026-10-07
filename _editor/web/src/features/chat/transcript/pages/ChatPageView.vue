<script setup lang="ts">
import type { Page } from "@intentic/sandbox-contract";
import { ConfirmDialog, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useChatSurface } from "../../tools/chatToolSurface";
import ChatPageFrame from "./ChatPageFrame.vue";
import { usePageActions } from "./usePageActions";

// A page the agent showed, inline where its reply continues: the page itself on the conversation's own background,
// then a quiet caption naming it with what a reader can do with it. A page the agent has since redrawn folds to one line
// here, since the one that stands is further down; it opens again on a press.

const t = useT();

const props = defineProps<{ page: Page }>();

const actions = usePageActions(() => props.page);
const surface = useChatSurface();
const earlierOpen = ref(false);
const folded = computed(() => props.page.superseded === true && !earlierOpen.value);

// What the page's scripts threw, and whether the agent that showed it heard; when it did not, the reader may ask.
const errors = ref<readonly string[]>([]);
const told = ref(false);
const onFault = (thrown: readonly string[], heard: boolean): void => {
    errors.value = thrown;
    told.value = heard;
};
const askFix = (): void => {
    const listed = errors.value.map((error) => `- ${error}`).join(`\n`);
    actions.message(t(`chat.chatPages.fixRequest`, { title: props.page.title, id: props.page.id, errors: listed }));
};

const confirming = ref(false);
const confirmPublish = async (): Promise<void> => {
    await actions.publish();
    confirming.value = false;
};
</script>

<template>
    <!-- Inset like the answer's own prose, so the page's left edge lines up with the words around it. -->
    <section class="flex w-full flex-col gap-1" :aria-label="page.title" data-chat-page>
        <div v-if="folded" class="flex min-w-0 items-center gap-1.5 px-3.5 text-2xs text-subtle">
            <Icon name="history" class="shrink-0 text-2xs" />
            <span class="min-w-0 truncate">{{ t(`chat.chatPages.superseded`, { title: page.title }) }}</span>
            <button type="button" class="shrink-0 cursor-pointer font-medium text-link hover:underline" @click="earlierOpen = true">
                {{ t(`chat.chatPages.showEarlier`) }}
            </button>
        </div>
        <template v-else>
            <div class="px-3.5">
                <ChatPageFrame :page="page" :message="actions.message" @fault="onFault" />
            </div>
            <!-- The caption: what it is, where it came from, and the two things to do with it beside using it. -->
            <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-3.5 text-2xs text-subtle">
                <span class="flex min-w-0 items-center gap-1.5">
                    <Icon name="globe" class="shrink-0 text-2xs" />
                    <span class="min-w-0 truncate" v-tooltip.top.overflow="page.title">{{ page.title }}</span>
                </span>
                <button
                    v-if="page.source && surface.openFile"
                    type="button"
                    class="min-w-0 cursor-pointer truncate hover:text-content"
                    v-tooltip.top="t(`chat.chatPages.openSource`)"
                    @click="surface.openFile?.(page.source!)"
                >
                    {{ t(`chat.chatPages.fromFile`, { path: page.source }) }}
                </button>
                <span v-if="errors.length > 0" class="flex min-w-0 items-center gap-1 text-danger" v-tooltip.top="errors.join(`\n`)">
                    <Icon name="exclamation-circle" class="shrink-0 text-2xs" />
                    <span class="min-w-0 truncate">{{ t(`chat.chatPages.threw`, { count: errors.length }, errors.length) }}</span>
                </span>
                <span v-if="errors.length > 0 && told">{{ t(`chat.chatPages.agentTold`) }}</span>
                <button v-else-if="errors.length > 0" type="button" class="cursor-pointer font-medium text-link hover:underline" @click="askFix">
                    {{ t(`chat.chatPages.askFix`) }}
                </button>
                <button v-if="actions.canExpand" type="button" class="cursor-pointer font-medium hover:text-content" @click="actions.expand">
                    {{ t(`chat.chatPages.expand`) }}
                </button>
                <button
                    type="button"
                    class="cursor-pointer font-medium hover:text-content disabled:cursor-default"
                    :disabled="actions.publishing.value"
                    @click="confirming = true"
                >
                    {{ t(`chat.chatPages.publish`) }}
                </button>
                <button
                    v-if="page.superseded && earlierOpen"
                    type="button"
                    class="cursor-pointer font-medium hover:text-content"
                    @click="earlierOpen = false"
                >
                    {{ t(`chat.chatPages.hideEarlier`) }}
                </button>
                <span v-if="actions.published.value" class="flex min-w-0 items-center gap-1 text-success">
                    <Icon name="check" class="shrink-0 text-2xs" />
                    <a
                        v-if="actions.published.value.url"
                        :href="actions.published.value.url"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="min-w-0 truncate hover:underline"
                        >{{ t(`chat.chatPages.publishedCopied`) }}</a
                    >
                    <span v-else class="min-w-0 truncate">{{ t(`chat.chatPages.publishedNoAddress`, { path: actions.published.value.path }) }}</span>
                </span>
                <span v-if="actions.publishFailed.value" class="min-w-0 truncate text-danger" v-tooltip.top="actions.publishFailed.value">
                    {{ t(`chat.chatPages.publishFailed`) }}
                </span>
            </div>
        </template>
        <ConfirmDialog
            :open="confirming"
            :header="t(`chat.chatPages.publishHeader`)"
            header-icon="globe"
            :confirm-label="t(`chat.chatPages.publishConfirm`)"
            confirm-icon="upload"
            :destructive="false"
            :loading="actions.publishing.value"
            @cancel="confirming = false"
            @confirm="confirmPublish"
        >
            <p class="text-xs text-muted">{{ t(`chat.chatPages.publishWarning`, { title: page.title }) }}</p>
        </ConfirmDialog>
    </section>
</template>
