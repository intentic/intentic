<!-- Recently deleted: the passwords removed in the last 30 days, each put back as it was or deleted for good. -->
<script setup lang="ts">
import { Button, ConfirmDialog, Icon, messageOr, Notice, ui } from "@intentic/extension-ui";
import { timeAgo } from "@intentic/extension-ui/format";
import { onMounted, ref, shallowRef, watch } from "vue";
import { t } from "../i18n.js";
import ItemTile from "./ItemTile.vue";
import type { PasswordsPort, RemovedPassword } from "./port.js";

const { port, now, count } = defineProps<{
    port: PasswordsPort;
    now: number;
    /** How many the vault says it keeps: read again when that changes (a removal in another window, a sync). */
    count: number;
}>();
const emit = defineEmits<{ changed: []; restored: [name: string] }>();

const removed = shallowRef<readonly RemovedPassword[]>([]);
const error = ref<string | undefined>(undefined);
const waiting = ref<string | undefined>(undefined);
const confirming = ref<{ readonly name?: string; readonly title?: string } | undefined>(undefined);

const read = async (): Promise<void> => {
    try {
        removed.value = (await port.recentlyDeleted?.()) ?? [];
    } catch (failure) {
        error.value = messageOr(failure, t(`app.error.read`));
    }
};
onMounted(read);
watch(() => count, read);

const act = async (what: string, task: () => Promise<void>): Promise<void> => {
    waiting.value = what;
    error.value = undefined;
    try {
        await task();
        await read();
        emit(`changed`);
    } catch (failure) {
        error.value = messageOr(failure, t(`app.error.act`));
    } finally {
        waiting.value = undefined;
    }
};

const putBack = (name: string): Promise<void> =>
    act(`back:${name}`, async () => {
        await port.undoRemove?.(name);
        emit(`restored`, name);
    });
const purge = (): Promise<void> =>
    act(`purge`, async () => {
        const name = confirming.value?.name;
        await port.purge?.(name);
        confirming.value = undefined;
    });
</script>

<template>
    <section class="ui-softscroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-10 pr-1" :aria-label="t(`app.removed.title`)">
        <header class="flex flex-wrap items-center gap-3">
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <h2 class="text-lg font-semibold text-content">{{ t(`app.removed.title`) }}</h2>
                <p class="text-xs text-muted">{{ t(`app.removed.help`) }}</p>
            </div>
            <Button
                v-if="removed.length > 0 && port.purge"
                tier="boring"
                size="small"
                :label="t(`app.removed.empty`)"
                :disabled="waiting !== undefined"
                @click="confirming = {}"
            />
        </header>

        <Notice v-if="error" tone="danger" size="sm" @dismiss="error = undefined">{{ error }}</Notice>

        <p v-if="removed.length === 0" class="text-sm text-subtle">{{ t(`app.removed.none`) }}</p>
        <ul v-else class="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-card">
            <li v-for="entry in removed" :key="entry.item.name" class="flex items-center gap-3 px-4 py-3">
                <ItemTile :item="entry.item" />
                <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm text-content">{{ entry.item.title }}</span>
                    <span class="truncate text-2xs text-muted">
                        {{ [entry.item.username, t(`app.removed.when`, { when: timeAgo(entry.removedAt, { now }) })].filter(Boolean).join(` · `) }}
                    </span>
                </div>
                <Icon v-if="waiting === `back:${entry.item.name}`" name="spinner" spin class="text-info" />
                <button type="button" :class="ui.textButton({ size: `xs` })" :disabled="waiting !== undefined" @click="putBack(entry.item.name)">
                    {{ t(`app.removed.putBack`) }}
                </button>
                <button
                    v-if="port.purge"
                    type="button"
                    :class="ui.textButton({ size: `xs`, tone: `danger` })"
                    :disabled="waiting !== undefined"
                    @click="confirming = { name: entry.item.name, title: entry.item.title }"
                >
                    {{ t(`app.removed.deleteForGood`) }}
                </button>
            </li>
        </ul>

        <ConfirmDialog
            :open="confirming !== undefined"
            :header="confirming?.name === undefined ? t(`app.removed.emptyAsk`) : t(`app.removed.deleteAsk`, { title: confirming.title ?? `` })"
            :description="t(`app.removed.cannotUndo`)"
            :confirm-label="confirming?.name === undefined ? t(`app.removed.empty`) : t(`app.removed.deleteForGood`)"
            :loading="waiting === `purge`"
            @cancel="confirming = undefined"
            @confirm="purge()"
        />
    </section>
</template>
