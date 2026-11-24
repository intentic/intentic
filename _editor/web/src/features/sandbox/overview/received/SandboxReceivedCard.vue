<script setup lang="ts">
import type { ReceivedDrop } from "@intentic/sandbox-contract/schemas/account-routes";
import { errorMessage } from "@intentic/base/errors";
import { Button, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { formatBytes } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { sandboxRaw } from "../../../../client/sandbox/sandboxRaw";
import { RECEIVED_ANCHOR } from "./receivedAnchor";
import { useReceivedDrops } from "./useReceivedDrops";

// What other sandboxes the reader is in dropped here as them (`sandboxes send` over there, account-routing.md): a note and
// files that started nothing. Shown only while one waits, to the people a drop names and to maintainers (the daemon cuts
// the list). Take copies the files into a folder of the workspace, never over a file already there; Delete lets it go.
// The note is another sandbox's words, drawn as plain text.

const t = useT();
const { drops, refresh } = useReceivedDrops();

// The folder each drop would be taken into, editable: by default one named for where it came from.
const folders = ref<Record<string, string>>({});
const folderOf = (drop: ReceivedDrop): string => folders.value[drop.id] ?? `received/${drop.from.sandboxName.replace(/[^\w.-]+/gu, `-`)}`;
const setFolder = (drop: ReceivedDrop, value: string): void => {
    folders.value = { ...folders.value, [drop.id]: value };
};

const busy = ref<string | undefined>();
const outcome = ref<{ readonly tone: `success` | `danger`; readonly title: string; readonly detail?: string } | undefined>();

const act = async (drop: ReceivedDrop, task: () => Promise<string | undefined>): Promise<void> => {
    if (busy.value !== undefined) {
        return;
    }
    busy.value = drop.id;
    outcome.value = undefined;
    try {
        const done = await task();
        outcome.value = done === undefined ? undefined : { tone: `success`, title: done };
        await refresh();
    } catch (error) {
        outcome.value = { tone: `danger`, title: t(`sandbox.sandboxReceivedCard.failed`), detail: errorMessage(error) };
    } finally {
        busy.value = undefined;
    }
};

const take = (drop: ReceivedDrop): Promise<void> =>
    act(drop, async () => {
        const folder = folderOf(drop).trim();
        const taken = await sandboxRaw(`POST /account/inbox/{id}/take`, { params: { id: drop.id }, input: { dest: folder } });
        return t(`sandbox.sandboxReceivedCard.taken`, { folder: taken.dest, files: taken.files.join(`, `) });
    });

const remove = (drop: ReceivedDrop): Promise<void> =>
    act(drop, async () => {
        await sandboxRaw(`DELETE /account/inbox/{id}`, { params: { id: drop.id } });
        return undefined;
    });

const filesLine = (drop: ReceivedDrop): string =>
    [
        t(`sandbox.sandboxReceivedCard.files`, { count: drop.files.length }, drop.files.length),
        ...drop.files.map((file) => `${file.name} (${formatBytes(file.size)})`),
    ].join(` · `);

const notice = computed(() => outcome.value);
</script>

<template>
    <RowGroup v-if="drops.length > 0" :id="RECEIVED_ANCHOR" :label="t(`sandbox.sandboxReceivedCard.heading`)" data-received-drops>
        <RowNote icon="download">{{ t(`sandbox.sandboxReceivedCard.whatFor`) }}</RowNote>
        <Notice v-if="notice" :of="notice" />
        <div class="divide-y divide-line-subtle">
            <Row
                v-for="drop in drops"
                :key="drop.id"
                icon="download"
                :title="t(`sandbox.sandboxReceivedCard.fromAs`, { sandbox: drop.from.sandboxName, person: drop.person })"
                :description="filesLine(drop)"
            >
                <template #below>
                    <div class="flex flex-col gap-2">
                        <p class="whitespace-pre-wrap text-xs text-muted">{{ drop.note ?? t(`sandbox.sandboxReceivedCard.noNote`) }}</p>
                        <p v-if="drop.crossesOrg" class="text-2xs text-warning">{{ t(`sandbox.sandboxReceivedCard.crossesOrg`) }}</p>
                        <p v-if="drop.wake?.delivered" class="text-2xs text-subtle">
                            {{ t(`sandbox.sandboxReceivedCard.saidInto`, { conversation: drop.wake.conversationId }) }}
                        </p>
                        <form v-if="drop.files.length > 0" class="flex flex-wrap items-center gap-2" @submit.prevent="take(drop)">
                            <input
                                :value="folderOf(drop)"
                                type="text"
                                autocomplete="off"
                                :aria-label="t(`sandbox.sandboxReceivedCard.folder`)"
                                :class="ui.input({ size: `sm` }, `min-w-56 flex-1`)"
                                @input="setFolder(drop, ($event.target as HTMLInputElement).value)"
                            />
                            <Button
                                tier="accent"
                                type="submit"
                                size="small"
                                :label="t(`sandbox.sandboxReceivedCard.take`)"
                                :loading="busy === drop.id"
                                :disabled="busy !== undefined"
                            />
                        </form>
                    </div>
                </template>
                <template #control>
                    <Button
                        :label="t(`sandbox.sandboxReceivedCard.delete`)"
                        size="small"
                        tier="quiet"
                        tone="danger"
                        :disabled="busy !== undefined"
                        @click="remove(drop)"
                    />
                </template>
            </Row>
        </div>
    </RowGroup>
</template>
