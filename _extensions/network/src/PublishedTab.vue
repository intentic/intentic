<!-- This sandbox's own log: write a post (it goes to Approvals first), see what waits for a yes, what is published, and
     where anyone reads and verifies it. -->
<script setup lang="ts">
import { Button, Row, RowGroup, RowNote, SegmentedControl, StatusBadge, timeAgo, ui, useNow } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { t } from "./i18n.js";
import type { Publishing } from "./wire";

const { publishing, canWrite, busy } = defineProps<{ publishing: Publishing; canWrite: boolean; busy: boolean }>();
const emit = defineEmits<{
    publish: [type: `SocialMediaPosting` | `Article`, headline: string, text: string, keywords: readonly string[]];
    withdraw: [seq: number];
}>();
const now = useNow();

const type = ref<`SocialMediaPosting` | `Article`>(`SocialMediaPosting`);
const types = computed(() => [
    { value: `SocialMediaPosting` as const, label: t(`published.post`) },
    { value: `Article` as const, label: t(`published.article`) },
]);
const headline = ref(``);
const text = ref(``);
const keywords = ref(``);

const submit = (): void => {
    if (text.value.trim() === ``) {
        return;
    }
    const words = keywords.value.split(`,`).map((word) => word.trim()).filter((word) => word !== ``);
    emit(`publish`, type.value, headline.value.trim(), text.value.trim(), words);
    headline.value = ``;
    text.value = ``;
    keywords.value = ``;
};

const describe = (row: Publishing[`published`][number]): string => {
    const when = timeAgo(Date.parse(row.publishedAt), { now: now.value });
    if (row.tombstoneOf !== null) {
        return t(`published.withdrawNote`, { seq: row.tombstoneOf, when });
    }
    return `#${row.seq} · ${row.type ?? ``} · ${when}`;
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <RowGroup v-if="canWrite" :label="t(`published.compose`)">
            <RowNote variant="block"><div class="flex flex-col gap-2">
                <SegmentedControl v-model="type" :options="types" size="xs" :aria-label="t(`published.kind`)" />
                <input v-if="type === `Article`" v-model="headline" :class="ui.input({ size: `sm` })" :placeholder="t(`published.headline`)" maxlength="300" />
                <textarea v-model="text" :class="ui.input({}, `min-h-24`)" :placeholder="t(`published.text`)" maxlength="20000" />
                <input v-model="keywords" :class="ui.input({ size: `sm` })" :placeholder="t(`published.keywords`)" />
                <div class="flex items-center gap-3">
                    <Button :label="t(`published.submit`)" size="small" tier="accent" :loading="busy" :disabled="text.trim() === ``" @click="submit" />
                    <span class="text-2xs text-subtle">{{ t(`published.approvalNote`) }}</span>
                </div>
            </div></RowNote>
        </RowGroup>

        <RowGroup v-if="publishing.waiting.length > 0" :label="t(`published.waiting`)">
            <Row
                v-for="draft in publishing.waiting"
                :key="draft.id"
                :title="draft.headline"
                :description="draft.kind === `publish` ? t(`published.waitingPublish`, { when: timeAgo(draft.createdAt, { now }) }) : t(`published.waitingWithdraw`, { when: timeAgo(draft.createdAt, { now }) })"
            >
                <template #meta>
                    <StatusBadge v-if="draft.cosign === `required`" variant="warning" :label="t(`published.passkeyRequired`)" size="sm" />
                </template>
            </Row>
        </RowGroup>

        <RowGroup :label="t(`published.title`, { count: publishing.size }, publishing.size)">
            <template #info>
                <a v-if="publishing.catalogUrl" :href="publishing.catalogUrl" target="_blank" rel="noopener" class="text-2xs text-muted underline">{{ t(`published.publicLink`) }}</a>
            </template>
            <Row v-for="row in publishing.published" :key="row.seq" :title="row.withdrawn ? t(`published.withdrawn`) : (row.headline ?? t(`published.tombstone`))" :description="describe(row)">
                <template #meta>
                    <StatusBadge v-if="row.cosigned" variant="success" :label="t(`published.cosigned`)" size="sm" />
                </template>
                <template v-if="canWrite && !row.withdrawn && row.tombstoneOf === null" #control>
                    <Button :label="t(`published.withdraw`)" size="small" tier="quiet" :disabled="busy" @click="emit(`withdraw`, row.seq)" />
                </template>
            </Row>
            <RowNote v-if="publishing.published.length === 0">{{ t(`published.empty`) }}</RowNote>
        </RowGroup>
    </div>
</template>
