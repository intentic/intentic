<script setup lang="ts">
import { Button, Icon, Notice, type NoticeModel, Row, RowGroup, SkeletonRows, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, useTemplateRef, watch } from "vue";
import { useRoute } from "vue-router";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { DELETED_ANCHOR } from "../deviceLinks";
import { daysLeft, trashSection } from "./trashWindow";
import { useSandboxTrash } from "./useSandboxTrash";

// Sandboxes this account deleted that can still come back, as the Devices board's last group: the board is where every
// sandbox the account runs is laid out by the machine it runs on, so the ones that left it are kept at its foot rather
// than in one sandbox's settings (where they sat until 2026-10-07, under a hub titled with a box they have nothing to do
// with). Drawn only while something is recoverable, or for a reader who came for it by `#deleted` (trashSection).

const t = useT();
const route = useRoute();
const sandbox = useSandbox();
const trash = useSandboxTrash();

const asked = computed(() => route.hash === `#${DELETED_ANCHOR}`);
const shows = computed(() =>
    trashSection({
        rows: trash.recoverable.value.length,
        read: trash.deleted.value !== undefined,
        readError: trash.readError.value !== undefined,
        asked: asked.value,
    }),
);

// A failed restore is said beside the row it failed on; a failed read only to a reader who asked (the section is
// otherwise not drawn at all).
const notice = computed<NoticeModel | undefined>(() => {
    if (trash.failed.value !== undefined) {
        return { tone: `danger`, title: t(`sandbox.recentlyDeleted.couldntRestore`), detail: trash.failed.value };
    }
    if (shows.value === `error` && trash.readError.value !== undefined) {
        return { tone: `danger`, title: t(`sandbox.recentlyDeleted.couldntRead`), detail: trash.readError.value };
    }
    return undefined;
});

// The router scrolls to a hash as it navigates, which is before this list has been read; so the section brings itself
// into view once it has something to show, once.
const section = useTemplateRef<HTMLElement>(`section`);
const stopScroll = watch(
    () => [shows.value, section.value] as const,
    ([state, element]) => {
        if (!asked.value || element === null || element === undefined || state === `hidden` || state === `reading`) {
            return;
        }
        void nextTick(() => element.scrollIntoView({ block: `start`, behavior: `smooth` }));
        stopScroll();
    },
);

// Restoring makes it the active sandbox: the reader asked for that box back, and an own-machine one has a connection
// to set up again, which is the next thing its screen asks for.
const restore = async (trashId: string): Promise<void> => {
    const restored = await trash.restore(trashId);
    if (restored !== undefined) {
        sandbox.select(restored.id);
    }
};
</script>

<template>
    <section v-if="shows !== `hidden`" :id="DELETED_ANCHOR" ref="section" class="flex scroll-mt-4 flex-col gap-3">
        <Notice v-if="notice" :of="notice" />

        <RowGroup
            v-if="shows !== `error`"
            :label="t(`sandbox.words.recentlyDeleted`)"
            :equal-rows="shows === `rows`"
        >
            <div v-if="shows === `reading`" role="status" aria-busy="true">
                <span class="sr-only">{{ t(`sandbox.recentlyDeleted.reading`) }}</span>
                <SkeletonRows :rows="1" description control />
            </div>

            <p v-else-if="shows === `empty`" :class="ui.emptyState('flex items-center justify-center gap-2')">
                <Icon name="trash" class="text-subtle" aria-hidden="true" />
                {{ t(`sandbox.recentlyDeleted.nothingToRestore`) }}
            </p>

            <!-- The board's own sandbox glyph, so a deleted box reads as one of the boxes above it, only gone. -->
            <template v-else>
                <Row
                    v-for="row in trash.recoverable.value"
                    :key="row.id"
                    icon="box"
                    :title="row.name"
                    :description="row.hosted ? t(`sandbox.recentlyDeleted.comesBackWithMachine`) : t(`sandbox.recentlyDeleted.comesBackAsName`)"
                >
                    <template #meta>
                        <span class="text-2xs text-subtle">{{
                            t(`sandbox.recentlyDeleted.daysLeftToRestore`, { count: daysLeft(row.purgeAfter) }, daysLeft(row.purgeAfter))
                        }}</span>
                    </template>
                    <template #control>
                        <Button
                            size="small"
                            tier="boring"
                            :label="t(`ui.action.restore`)"
                            :loading="trash.restoring.value === row.id"
                            :disabled="trash.restoring.value !== undefined"
                            @click="void restore(row.id)"
                        />
                    </template>
                </Row>
            </template>
        </RowGroup>
    </section>
</template>
