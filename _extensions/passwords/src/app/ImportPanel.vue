<!-- Import from another browser or password manager: pick its CSV export, see what it holds, then bring it in. The file is read here and never kept. -->
<script setup lang="ts">
import { Button, Icon, messageOr, Notice } from "@intentic/extension-ui";
import { ref, shallowRef } from "vue";
import { t } from "../i18n.js";
import { type ParsedImport, parseImport } from "./import/formats.js";
import type { ImportResult, PasswordsPort } from "./port.js";

const { port } = defineProps<{ port: PasswordsPort }>();
const emit = defineEmits<{ imported: [result: ImportResult] }>();

const input = ref<HTMLInputElement | undefined>(undefined);
const parsed = shallowRef<ParsedImport | undefined>(undefined);
const result = shallowRef<ImportResult | undefined>(undefined);
const error = ref<string | undefined>(undefined);
const running = ref(false);

const onFile = async (event: Event): Promise<void> => {
    const file = event.target instanceof HTMLInputElement ? event.target.files?.[0] : undefined;
    // Cleared at once, so picking the same file again reads it again, and the input holds no file a moment longer.
    if (event.target instanceof HTMLInputElement) {
        event.target.value = ``;
    }
    if (file === undefined) {
        return;
    }
    result.value = undefined;
    error.value = undefined;
    const read = parseImport(await file.text());
    parsed.value = read;
    if (read === undefined) {
        error.value = t(`app.import.unknown`);
    }
};

const run = async (): Promise<void> => {
    const rows = parsed.value;
    if (rows === undefined || rows.rows.length === 0) {
        return;
    }
    running.value = true;
    error.value = undefined;
    try {
        result.value = await port.importRows(rows.rows, rows.label);
        parsed.value = undefined;
        emit(`imported`, result.value);
    } catch (failure) {
        error.value = messageOr(failure, t(`app.error.act`));
    } finally {
        running.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-3">
        <input ref="input" type="file" accept=".csv,text/csv" class="hidden" @change="onFile" />
        <Notice v-if="error" tone="danger" size="sm" @dismiss="error = undefined">{{ error }}</Notice>
        <div v-if="parsed && parsed.rows.length > 0" class="flex flex-col gap-1 rounded-lg bg-overlay px-3 py-2 text-xs">
            <span class="font-medium text-content">{{ t(`app.import.found`, { count: parsed.rows.length, format: parsed.label }, parsed.rows.length) }}</span>
            <span v-if="parsed.skipped > 0" class="text-muted">{{ t(`app.import.skipped`, { count: parsed.skipped }, parsed.skipped) }}</span>
        </div>
        <div v-if="result" class="flex flex-col gap-1 text-xs" role="status">
            <span class="flex items-center gap-1.5 text-success"><Icon name="check" />{{ t(`app.import.result`, { ...result }) }}</span>
            <span class="text-muted">{{ t(`app.import.deleteFile`) }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
            <Button :tier="parsed && parsed.rows.length > 0 ? `boring` : undefined" :label="t(`app.import.pick`)" @click="input?.click()">
                <template #icon><Icon name="upload" /></template>
            </Button>
            <Button
                v-if="parsed && parsed.rows.length > 0"
                :label="t(`app.import.run`, { count: parsed.rows.length }, parsed.rows.length)"
                :loading="running"
                @click="run()"
            />
        </div>
    </div>
</template>
