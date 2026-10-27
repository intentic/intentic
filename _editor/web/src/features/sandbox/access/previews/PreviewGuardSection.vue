<script setup lang="ts">
import type { PreviewGuardScope } from "@intentic/sandbox-contract/schemas/ports";
import { Notice, type NoticeModel, Picker, Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { previewGuardChoices, usePreviewGuard } from "./usePreviewGuard";

// Previews on the Access tab's Sign-in part: whether opening one of this sandbox's previews from outside asks for a
// member's sign-in. The owner picks; everyone else reads where it stands and who can change it, as the roster says of
// itself on People. Unread, the guard could be on or off, so nothing is drawn as either until the daemon has answered.

const t = useT();
const { served, isOwner, scope, locked, readError, busy, failure, choose } = usePreviewGuard();

const choices = computed(() => previewGuardChoices());
const current = computed(() => choices.value.find((choice) => choice.value === scope.value));
const unread = computed<NoticeModel | undefined>(() =>
    readError.value === undefined ? undefined : { tone: `danger`, title: t(`sandbox.previewGuardSection.couldntRead`), detail: readError.value },
);

const pick = (next: PreviewGuardScope | undefined): void => {
    if (next !== undefined) {
        void choose(next);
    }
};
</script>

<template>
    <RowGroup v-if="served && !locked" data-setting="access-previews" :label="t(`sandbox.previewGuardSection.title`)">
        <Row icon="eye" :title="t(`sandbox.previewGuardSection.whoCanOpen`)" :description="t(`sandbox.previewGuardSection.note`)">
            <template v-if="current" #control>
                <Picker
                    v-if="isOwner"
                    :model-value="current.value"
                    :options="choices"
                    :disabled="busy"
                    class="ui-field-sm w-72 max-w-full justify-between md:text-xs"
                    :aria-label="t(`sandbox.previewGuardSection.whoCanOpen`)"
                    :header="t(`sandbox.previewGuardSection.whoCanOpen`)"
                    @update:model-value="pick"
                />
                <span v-else class="text-xs text-muted">{{ current.label }}</span>
            </template>
        </Row>
        <RowNote v-if="current && !isOwner">{{ t(`sandbox.previewGuardSection.ownerChanges`) }}</RowNote>
        <RowNote v-if="unread || failure" variant="block">
            <div class="flex flex-col gap-3">
                <Notice v-if="unread" :of="unread" />
                <Notice v-if="failure" :of="failure" />
            </div>
        </RowNote>
    </RowGroup>
</template>
