<!-- The Network view: the curated feed, the sources it reads, and its settings, over the backend's one snapshot. -->
<script setup lang="ts">
import { Button, Icon, messageOr, NoticeStack, type NoticeModel, SegmentedControl, SkeletonRows, RowGroup, SplitView } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import FeedTab from "./FeedTab.vue";
import PeersTab from "./PeersTab.vue";
import PublishedTab from "./PublishedTab.vue";
import { host } from "./host";
import { t } from "./i18n.js";
import SettingsTab from "./SettingsTab.vue";
import SourcesTab from "./SourcesTab.vue";
import { useNetwork } from "./useNetwork";
import type { Source } from "./wire";

const { snapshot, refresh, add, remove, toggle, curate, publish, withdraw, release, discover } = useNetwork();
type Tab = `feed` | `sources` | `peers` | `published` | `settings`;
const tab = ref<Tab>(`feed`);
const tabs = computed(() => [
    { value: `feed` as const, label: t(`tabs.feed`), icon: `globe` as const },
    { value: `sources` as const, label: t(`tabs.sources`), icon: `link` as const, badge: snapshot.data.value?.sources.filter((source) => source.lastError !== null).length || undefined },
    { value: `peers` as const, label: t(`tabs.peers`), icon: `users` as const, badge: snapshot.data.value?.peers.filter((peer) => peer.state !== `ok`).length || undefined },
    { value: `published` as const, label: t(`tabs.published`), icon: `upload` as const, badge: snapshot.data.value?.publishing.waiting.length || undefined },
    { value: `settings` as const, label: t(`tabs.settings`), icon: `cog` as const },
]);

const data = computed(() => snapshot.data.value);
const busy = computed(() => add.isPending.value || remove.isPending.value || toggle.isPending.value || refresh.isPending.value);
const pressError = computed(() => [add, remove, toggle, refresh, curate, publish, withdraw, release, discover].map((press) => press.error.value).find((error) => error !== null));
const notices = computed<readonly (NoticeModel | undefined)[]>(() => [
    snapshot.error.value === null ? undefined : { tone: `danger`, title: t(`view.couldNotRead`), detail: messageOr(snapshot.error.value, ``) },
    pressError.value === undefined ? undefined : { tone: `danger`, title: t(`view.pressFailed`), detail: messageOr(pressError.value, ``) },
]);

const onAdd = (kind: Source[`kind`], address: string, label: string): void => add.mutate({ kind, address, label });
const onCurate = async (): Promise<void> => {
    const { conversationId } = await curate.mutateAsync();
    const api = host();
    api.chat.openAgent(conversationId);
};
</script>

<template>
    <SplitView :title="t(`title`)" scroll="page">
        <template #actions>
            <Button v-if="data?.canWrite && data.sources.length > 0" :label="t(`view.refresh`)" size="small" tier="quiet" :loading="refresh.isPending.value" @click="refresh.mutate(undefined)">
                <template #icon><Icon name="refresh" class="text-2xs" /></template>
            </Button>
        </template>

        <template #strips>
            <NoticeStack :of="notices" />
        </template>

        <template #detail>
          <div class="flex flex-col gap-4">
            <SegmentedControl v-model="tab" :options="tabs" variant="underline" />
            <RowGroup v-if="data === undefined" role="status" aria-busy="true">
                <SkeletonRows :rows="4" description />
            </RowGroup>
            <template v-else>
                <FeedTab v-if="tab === `feed`" :items="data.items" :uncurated="data.uncurated" :can-write="data.canWrite" :curating="curate.isPending.value" @curate="onCurate" />
                <SourcesTab
                    v-else-if="tab === `sources`"
                    :sources="data.sources"
                    :can-write="data.canWrite"
                    :busy="busy"
                    @add="onAdd"
                    @refresh="(id: string) => refresh.mutate(id)"
                    @toggle="(id: string, enabled: boolean) => toggle.mutate({ id, enabled })"
                    @remove="(id: string) => remove.mutate(id)"
                />
                <PeersTab
                    v-else-if="tab === `peers`"
                    :peers="data.peers"
                    :can-write="data.canWrite"
                    :busy="busy || release.isPending.value"
                    :hits="discover.data.value"
                    :searching="discover.isPending.value"
                    @follow="(address: string) => add.mutate({ kind: `intentic`, address, label: `` })"
                    @release="(sourceId: string) => release.mutate(sourceId)"
                    @search="(type: string, keyword: string) => discover.mutate({ type, keyword })"
                />
                <PublishedTab
                    v-else-if="tab === `published`"
                    :publishing="data.publishing"
                    :can-write="data.canWrite"
                    :busy="publish.isPending.value || withdraw.isPending.value"
                    @publish="(type, headline, text, keywords) => publish.mutate({ type, headline: headline || undefined, text, keywords: [...keywords] })"
                    @withdraw="(seq: number) => withdraw.mutate(seq)"
                />
                <SettingsTab v-else :settings="data.settings" :can-write="data.canWrite" @saved="snapshot.refetch()" />
            </template>
          </div>
        </template>
    </SplitView>
</template>
