<!-- A PROCESS'S PAGE, the same in both faces (processReport.ts): on Home in the chat's place, in a local window as a route
     of its shell. What it is and where it stands, how far, what it asks of the reader, why it stopped, and every press it
     takes, answered here rather than on another screen. The run is never this page's: leaving it changes nothing, which
     the page says. A face that has more to show (Devices' card on This computer) puts it in the slot. -->
<script setup lang="ts">
import { Button, Meter, Page, SandboxLogo, SectionHeader, toneTint, useCopied } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { type ProcessAction, processAsks, processLive, type ProcessNeed, type ProcessReport } from "../../app/environments/processes/processReport";
import { processTileOf } from "../../models/processes/processTiles";
import { processActionLabel, quietAction } from "../../models/processes/processWords";

const { report } = defineProps<{ report: ProcessReport | undefined }>();
const emit = defineEmits<{ act: [act: ProcessAction, need?: string] }>();
const t = useT();

const tile = computed(() => (report === undefined ? undefined : processTileOf(report)));
const share = computed(() => (report?.percent === undefined || !processLive(report) ? undefined : report.percent / 100));
const figures = computed(() => [report?.position, report?.remaining].filter((part): part is string => part !== undefined).join(` · `));
const actions = computed(() => report?.actions ?? []);
const needs = computed(() => report?.needs ?? []);

// A need's Copy is answered here, never by the run: its detail (the note for whoever manages the antivirus, the app's
// agent_install.rs) onto the clipboard, and the press says it landed.
const { copied, copy } = useCopied();
const copiedNeed = ref<string | undefined>(undefined);
const pressNeed = (act: ProcessAction, need: ProcessNeed, from: EventTarget | null): void => {
    if (act !== `copy`) {
        emit(`act`, act, need.id);
        return;
    }
    if (need.detail === undefined) {
        return;
    }
    copiedNeed.value = need.id;
    void copy(need.detail, from instanceof Element ? from : null);
};
const needActionLabel = (act: ProcessAction, need: ProcessNeed): string =>
    act === `copy` && copied.value && copiedNeed.value === need.id ? t(`processes.action.copied`) : processActionLabel(act, report);
</script>

<template>
    <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="tile?.title" data-process-page>
        <div class="min-h-0 flex-1 overflow-y-auto">
            <Page>
                <div class="mx-auto flex w-full max-w-lg flex-col gap-6 py-6">
                    <p v-if="report === undefined || tile === undefined" class="text-sm text-muted">{{ t(`processes.page.gone`) }}</p>
                    <template v-else>
                        <header class="flex items-start gap-4">
                            <SandboxLogo v-if="`logo` in tile.glyph" :image="null" :name="tile.glyph.logo" :size="48" class="shrink-0 rounded-xl" />
                            <span v-else class="flex size-12 shrink-0 items-center justify-center rounded-xl bg-content/5 text-xl text-muted">
                                <Icon :name="tile.glyph.icon" aria-hidden="true" />
                            </span>
                            <div class="flex min-w-0 flex-col gap-1">
                                <h1 class="truncate text-xl font-semibold text-content">{{ tile.title }}</h1>
                                <p class="flex items-center gap-2 text-sm text-muted" data-process-note>
                                    <Icon v-if="processLive(report) && !processAsks(report)" name="spinner" spin class="text-xs text-link" aria-hidden="true" />
                                    {{ tile.note }}
                                </p>
                            </div>
                        </header>

                        <div v-if="share !== undefined || figures !== ``" class="flex flex-col gap-1.5">
                            <Meter v-if="share !== undefined" :value="share" size="md" :label="tile.title" :valuetext="tile.note" class="w-full" />
                            <p v-if="figures !== ``" class="text-xs text-muted">{{ figures }}</p>
                        </div>

                        <div v-if="report.failure" :class="toneTint(`danger`, `soft`, `flex flex-col gap-1 rounded-lg p-3`)" data-process-failure>
                            <span class="text-xs font-medium text-danger">{{ t(`processes.page.failedBecause`) }}</span>
                            <p class="whitespace-pre-line text-sm text-content">{{ report.failure }}</p>
                        </div>

                        <div v-if="needs.length > 0" class="flex flex-col gap-2" data-process-needs>
                            <SectionHeader :label="t(`processes.page.needs`)" :heading="2" />
                            <ul class="flex flex-col gap-2">
                                <li v-for="need in needs" :key="need.id" class="flex flex-col gap-2 rounded-lg bg-card p-3 shadow-sm">
                                    <div class="flex min-w-0 flex-col gap-0.5">
                                        <span class="text-sm font-medium text-content">{{ need.label }}</span>
                                        <span v-if="need.detail" class="whitespace-pre-line text-xs text-muted" data-process-need-detail>{{ need.detail }}</span>
                                    </div>
                                    <div v-if="need.actions?.length" class="flex flex-wrap gap-2">
                                        <Button
                                            v-for="(act, at) in need.actions"
                                            :key="act"
                                            size="small"
                                            :label="needActionLabel(act, need)"
                                            :tier="quietAction(act) ? `quiet` : at === 0 ? `accent` : `boring`"
                                            @click="pressNeed(act, need, $event.currentTarget)"
                                        />
                                    </div>
                                </li>
                            </ul>
                        </div>

                        <slot :report="report" />

                        <div v-if="actions.length > 0" class="flex flex-wrap items-center gap-2" data-process-actions>
                            <Button
                                v-for="(act, at) in actions"
                                :key="act"
                                :label="processActionLabel(act, report)"
                                :tier="quietAction(act) ? `quiet` : at === 0 ? `accent` : `boring`"
                                @click="emit(`act`, act)"
                            />
                        </div>

                        <p v-if="report.state === `running`" class="text-xs text-muted">{{ t(`processes.page.meanwhile`) }}</p>
                    </template>
                </div>
            </Page>
        </div>
    </section>
</template>
