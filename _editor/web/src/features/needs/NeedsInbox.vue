<!-- Needs you: everything waiting on a person's answer, whichever part of the app holds it (docs/architecture/needs.md).
     A list of short rows beside the one opened, answered in place, and the next one opened as it leaves. What was already
     answered and what is still allowed are one tab away rather than in the way. -->
<script setup lang="ts">
import { flattenQuery } from "@intentic/extension-api";
import { isOpenNeed } from "@intentic/sandbox-contract";
import { SegmentedControl, SplitView, ui, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAgents } from "../agents/fleet/useAgents";
import InboxDetail from "./inbox/InboxDetail.vue";
import { type InboxItem, nextAfter } from "./inbox/inboxItems";
import InboxList from "./inbox/InboxList.vue";
import { useInbox } from "./inbox/useInbox";
import NeedCard from "./NeedCard.vue";
import StandingGrants from "./StandingGrants.vue";
import { useNeeds } from "./useNeeds";

const t = useT();
const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();

const { ordered, sections } = useInbox();
const { needs } = useNeeds();
const { agentById } = useAgents();

type Tab = `waiting` | `answered` | `allowed`;
const TABS: readonly Tab[] = [`waiting`, `answered`, `allowed`];
// A key the URL leaves out, or names with no value, is no choice at all.
const queryOf = (key: string): string | undefined => {
    const value = flattenQuery(route.query)[key];
    return value === undefined || value === `` ? undefined : value;
};
// The URL holds the tab and the opened item, so a reload, a link or Back lands where the reader was.
const tab = computed<Tab>({
    get: () => TABS.find((candidate) => candidate === queryOf(`tab`)) ?? `waiting`,
    set: (value) => void router.replace({ query: { ...route.query, tab: value === `waiting` ? undefined : value, item: undefined } }),
});
const tabs = computed(() => [
    // The control hides a zero itself.
    { value: `waiting` as const, label: t(`needs.inbox.tabWaiting`), badge: ordered.value.length },
    { value: `answered` as const, label: t(`needs.inbox.tabAnswered`) },
    { value: `allowed` as const, label: t(`needs.inbox.tabAllowed`) },
]);

// The opened item is the one the URL names; with room for both panes and none named, the first in the order, so the
// page opens on an answer rather than on an empty half. A phone opens nothing until a row is pressed.
const named = computed(() => queryOf(`item`));
// A list of none or one, so the template can bind the item it draws without asserting it exists.
const opened = (compact: boolean): readonly InboxItem[] => {
    const item = ordered.value.find((candidate) => candidate.key === named.value) ?? (compact ? undefined : ordered.value[0]);
    return item === undefined ? [] : [item];
};

// A press on a phone is a step into the item (Back returns to the list); beside the list it only moves the selection.
const select = (key: string): void => {
    const query = { ...route.query, item: key };
    void (mobile.value ? router.push({ query }) : router.replace({ query }));
};
const back = (): void => void router.replace({ query: { ...route.query, item: undefined } });

// Answered, withdrawn or released: the item leaves the list, and the reader goes on to what took its place rather than
// to an empty pane, which is how a queue of five is cleared in five presses.
watch(ordered, (after, before) => {
    const gone = named.value;
    if (gone === undefined || after.some((item) => item.key === gone)) {
        return;
    }
    const next = nextAfter(before, after, gone);
    void router.replace({ query: { ...route.query, item: next } });
});

// What was answered, newest first, for "did I already do that".
const answered = computed(() => needs.value.filter((need) => !isOpenNeed(need)).slice(0, 12));
const titleOf = (conversationId: string): string => agentById(conversationId)?.title ?? t(`needs.inbox.untitled`);
</script>

<template>
    <SplitView
        :title="t(`needs.inbox.title`)"
        :description="t(`needs.inbox.description`)"
        :scroll="mobile ? `page` : `panes`"
        mobile="swap"
        :detail-open="tab !== `waiting` || named !== undefined || ordered.length === 0"
    >
        <template #actions>
            <SegmentedControl v-model="tab" :options="tabs" :aria-label="t(`needs.inbox.tabs`)" />
        </template>

        <template v-if="tab === `waiting` && ordered.length > 0" #rail>
            <InboxList :sections="sections" :selected="named ?? (mobile ? undefined : ordered[0]?.key)" @select="select" />
        </template>

        <template #detail="{ compact }">
            <div class="scrollbar-stable min-h-0 flex-1 overflow-y-auto pb-8" :class="mobile ? `` : `pr-2`">
                <template v-if="tab === `waiting`">
                    <!-- Nothing at all: said once, with what would put something here. -->
                    <div v-if="ordered.length === 0" :class="ui.emptyState(`flex flex-col items-center gap-2 py-16`)">
                        <Icon name="check-circle" class="text-2xl text-success" />
                        <p class="text-sm text-content">{{ t(`needs.inbox.nothing`) }}</p>
                        <p class="max-w-sm text-xs text-muted">{{ t(`needs.inbox.nothingHint`) }}</p>
                    </div>
                    <template v-else>
                        <template v-for="item in opened(compact)" :key="item.key">
                            <!-- On a phone the item is a page of its own; the way back names where it goes. -->
                            <button v-if="compact" type="button" :class="ui.textAction(`mb-4 gap-1`)" @click="back">
                                <Icon name="arrow-left" class="text-2xs" /> {{ t(`needs.inbox.back`) }}
                            </button>
                            <InboxDetail :item="item" />
                        </template>
                        <p v-if="opened(compact).length === 0" :class="ui.emptyState(`py-16`)">{{ t(`needs.inbox.pick`) }}</p>
                    </template>
                </template>

                <div v-else-if="tab === `answered`" class="flex max-w-read flex-col gap-2">
                    <p v-if="answered.length === 0" :class="ui.emptyState(`py-16`)">{{ t(`needs.inbox.answeredEmpty`) }}</p>
                    <NeedCard v-for="need in answered" :key="need.id" :need-id="need.id" />
                </div>

                <div v-else class="max-w-read">
                    <StandingGrants :title-of="titleOf" :empty="t(`needs.inbox.allowedEmpty`)" />
                </div>
            </div>
        </template>
    </SplitView>
</template>
