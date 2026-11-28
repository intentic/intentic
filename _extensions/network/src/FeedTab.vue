<!-- The feed: best curator score first, then newest; each item says where it came from and how much of it is proven. -->
<script setup lang="ts">
import { Button, Icon, Row, RowGroup, RowNote, StatusBadge, timeAgo, useNow } from "@intentic/extension-ui";
import { t } from "./i18n.js";
import type { Item } from "./wire";

const { items, uncurated, canWrite, curating } = defineProps<{
    items: readonly Item[];
    uncurated: number;
    canWrite: boolean;
    curating: boolean;
}>();
const emit = defineEmits<{ curate: [] }>();
const now = useNow();

// What the item's proof says, as the badge the row wears.
interface ProofBadge {
    readonly variant: `success` | `danger` | `neutral`;
    readonly label: string;
}
const proofOf = (item: Item): ProofBadge => {
    if (item.verification === `signature-valid`) {
        return { variant: `success`, label: t(`feed.signed`) };
    }
    return item.verification === `signature-invalid` ? { variant: `danger`, label: t(`feed.invalid`) } : { variant: `neutral`, label: t(`feed.unsigned`) };
};

const descriptionOf = (item: Item): string => {
    const record = item.record;
    const when = record.datePublished === undefined ? timeAgo(item.fetchedAt, { now: now.value }) : timeAgo(Date.parse(record.datePublished), { now: now.value });
    const by = record.author?.name === undefined || record.author.name === `` ? `` : `${record.author.name} · `;
    const summary = item.summary ?? (record.text ?? record.articleBody ?? ``).slice(0, 220);
    return `${by}${record.sdPublisher.name.replace(`intentic.network/`, ``)} · ${when}${summary === `` ? `` : ` — ${summary}`}`;
};

const open = (item: Item): void => {
    const url = item.record.url ?? item.nativeUrl;
    if (url !== undefined) {
        window.open(url, `_blank`, `noopener`);
    }
};
</script>

<template>
    <RowGroup :label="t(`feed.title`)">
        <template #actions>
            <Button
                v-if="canWrite && uncurated > 0"
                :label="t(`feed.curate`, { count: uncurated }, uncurated)"
                size="small"
                tier="quiet"
                :loading="curating"
                @click="emit(`curate`)"
            >
                <template #icon><Icon name="sparkles" class="text-2xs" /></template>
            </Button>
        </template>
        <Row
            v-for="item in items"
            :key="item.id"
            :title="item.record.headline || t(`feed.untitled`)"
            :description="descriptionOf(item)"
            as="button"
            interactive
            @click="open(item)"
        >
            <template #meta>
                <span v-if="item.score !== null" class="text-2xs text-muted tabular-nums">{{ Math.round(item.score) }}</span>
                <StatusBadge v-for="label in item.labels.slice(0, 3)" :key="label" variant="info" :label="label" size="sm" />
                <StatusBadge :variant="proofOf(item).variant" :label="proofOf(item).label" size="sm" />
            </template>
        </Row>
        <RowNote v-if="items.length === 0">{{ t(`feed.empty`) }}</RowNote>
    </RowGroup>
</template>
