<script setup lang="ts">
import type { ComplianceDocumentFormat, ComplianceDocumentKind } from "@intentic/sandbox-contract";
import { Button, Icon, Notice, type NoticeModel, Row, RowGroup, RowNote, SegmentedControl, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { activeLocale, useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { documentLanguageFor } from "./dataProtection";
import { downloadDocument, usePreset } from "./useCompliance";

// Step 3: the three documents a data protection officer files, drafted from the settings at the moment of download.
// Last because of that: until the recommended protections are applied, a document describes the sandbox without them,
// which the step says, with the way back. Language and format are chosen once for all three; the documents were two
// buttons each, six for one choice made three times.

const emit = defineEmits<{ back: [] }>();

const t = useT();
const { items } = usePreset();
const pending = computed(() => (items.value ?? []).filter((item) => item.changes && item.available).length);

// The documents' language starts as the reader's own where the documents have it, and is theirs to change.
const language = ref<`pl` | `en`>(documentLanguageFor(activeLocale.value));
const LANGUAGES = [
    { label: `Polski`, value: `pl` as const },
    { label: `English`, value: `en` as const },
];
// Word first: it is what an office edits and files; Markdown is for whoever keeps their records as text.
const format = ref<ComplianceDocumentFormat>(`docx`);
const FORMATS = computed(() => [
    { label: t(`sandbox.dataProtection.formatWord`), value: `docx` as const },
    { label: t(`sandbox.dataProtection.formatMarkdown`), value: `md` as const },
]);

const DOCUMENTS: readonly ComplianceDocumentKind[] = [`ropa`, `dpia`, `toms`];
const downloading = ref<ComplianceDocumentKind>();
const downloadError = ref<NoticeModel>();
const download = async (kind: ComplianceDocumentKind): Promise<void> => {
    downloading.value = kind;
    downloadError.value = undefined;
    try {
        await downloadDocument(kind, language.value, format.value);
    } catch (error) {
        downloadError.value = noticeFrom(error, t(`sandbox.dataProtection.couldntDownload`));
    } finally {
        downloading.value = undefined;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <p class="text-xs text-muted">{{ t(`sandbox.dataProtection.documentsIntro`) }}</p>

        <Notice v-if="pending > 0" tone="info">
            {{ t(`sandbox.dataProtection.pendingBeforeDocuments`, { count: pending }, pending) }}
            <button type="button" :class="ui.textButton()" @click="emit(`back`)">
                {{ t(`sandbox.dataProtection.goToProtections`) }}<Icon name="arrow-right" class="text-2xs" />
            </button>
        </Notice>

        <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div class="flex items-center gap-2">
                <span class="text-xs text-muted">{{ t(`sandbox.dataProtection.language`) }}</span>
                <SegmentedControl v-model="language" size="xs" :options="LANGUAGES" :aria-label="t(`sandbox.dataProtection.language`)" />
            </div>
            <div class="flex items-center gap-2">
                <span class="text-xs text-muted">{{ t(`sandbox.dataProtection.format`) }}</span>
                <SegmentedControl v-model="format" size="xs" :options="FORMATS" :aria-label="t(`sandbox.dataProtection.format`)" />
            </div>
        </div>

        <RowGroup :label="t(`sandbox.dataProtection.step.documents`)">
            <Row
                v-for="kind in DOCUMENTS"
                :key="kind"
                icon="file"
                :title="t(`sandbox.dataProtection.document.${kind}`)"
                :description="t(`sandbox.dataProtection.document.${kind}Note`)"
            >
                <template #control>
                    <Button
                        :label="t(`sandbox.dataProtection.download`)"
                        size="small"
                        tier="boring"
                        :loading="downloading === kind"
                        :disabled="downloading !== undefined && downloading !== kind"
                        @click="download(kind)"
                    >
                        <template #icon><Icon name="download" /></template>
                    </Button>
                </template>
            </Row>
            <RowNote v-if="downloadError" variant="block"><Notice :of="downloadError" /></RowNote>
            <RowNote>{{ t(`sandbox.dataProtection.documentsCaption`) }}</RowNote>
        </RowGroup>
    </div>
</template>
