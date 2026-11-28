<!-- The sources this sandbox reads: add one by kind and address, read one now, switch it off, remove it. -->
<script setup lang="ts">
import { Button, Icon, Row, RowGroup, RowNote, SegmentedControl, StatusBadge, timeAgo, ToggleSwitch, ui, useNow } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { t } from "./i18n.js";
import type { Source } from "./wire";

const { sources, canWrite, busy } = defineProps<{
    sources: readonly Source[];
    canWrite: boolean;
    busy: boolean;
}>();
const emit = defineEmits<{
    add: [kind: Source[`kind`], address: string, label: string];
    refresh: [id: string];
    toggle: [id: string, enabled: boolean];
    remove: [id: string];
}>();
const now = useNow();

const kind = ref<Source[`kind`]>(`rss`);
const address = ref(``);
const label = ref(``);
const kinds = computed(() =>
    ([`rss`, `bluesky`, `nostr`, `atlas`] as const).map((value) => ({ value, label: t(`sources.kind.${value}`) })),
);
const placeholder = computed(() => t(`sources.placeholder.${kind.value}`));

const submit = (): void => {
    if (address.value.trim() === ``) {
        return;
    }
    emit(`add`, kind.value, address.value.trim(), label.value.trim());
    address.value = ``;
    label.value = ``;
};

const stateOf = (source: Source): string => {
    if (source.lastError !== null) {
        return t(`sources.failing`, { count: source.failures, error: source.lastError });
    }
    return source.lastPollAt === null ? t(`sources.notRead`) : t(`sources.read`, { when: timeAgo(source.lastPollAt, { now: now.value }) });
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <RowGroup v-if="canWrite" :label="t(`sources.add`)">
            <RowNote variant="block"><div class="flex flex-col gap-2">
                <SegmentedControl v-model="kind" :options="kinds" size="xs" :aria-label="t(`sources.kindLabel`)" />
                <div class="flex flex-wrap gap-2">
                    <input v-model="address" :class="ui.input({ size: `sm` }, `min-w-64 flex-1`)" :placeholder="placeholder" spellcheck="false" @keydown.enter="submit" />
                    <input v-model="label" :class="ui.input({ size: `sm` }, `w-48`)" :placeholder="t(`sources.labelPlaceholder`)" @keydown.enter="submit" />
                    <Button :label="t(`sources.addButton`)" size="small" tier="accent" :loading="busy" :disabled="address.trim() === ``" @click="submit" />
                </div>
                <p class="text-2xs text-subtle">{{ t(`sources.trust.${kind}`) }}</p>
            </div></RowNote>
        </RowGroup>

        <RowGroup :label="t(`sources.title`)">
            <Row v-for="source in sources" :key="source.id" :title="source.label" :description="`${t(`sources.kind.${source.kind}`)} · ${source.address} · ${stateOf(source)}`" :tone="source.lastError === null ? undefined : `warning`">
                <template #meta>
                    <StatusBadge v-if="!source.enabled" variant="neutral" :label="t(`sources.off`)" size="sm" />
                </template>
                <template v-if="canWrite" #control>
                    <Button :aria-label="t(`sources.readNow`)" size="small" tier="quiet" :disabled="busy" @click="emit(`refresh`, source.id)">
                        <template #icon><Icon name="refresh" class="text-2xs" /></template>
                    </Button>
                    <ToggleSwitch :model-value="source.enabled" :aria-label="t(`sources.enabled`)" @update:model-value="(next: boolean) => emit(`toggle`, source.id, next)" />
                    <Button :aria-label="t(`sources.remove`)" size="small" tier="quiet" :disabled="busy" @click="emit(`remove`, source.id)">
                        <template #icon><Icon name="trash" class="text-2xs" /></template>
                    </Button>
                </template>
            </Row>
            <RowNote v-if="sources.length === 0">{{ t(`sources.empty`) }}</RowNote>
        </RowGroup>
    </div>
</template>
