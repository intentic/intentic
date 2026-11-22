<!-- A PROCESS'S PAGE, the same in both faces (processReport.ts): on Home in the chat's place, in a local window as a route
     of its shell. What it is and where it stands, how far, what it asks of the reader, why it stopped, and every press it
     takes, answered here rather than on another screen. The run is never this page's: leaving it changes nothing, which
     the page says. A face that has more to show (Devices' card on This computer) puts it in the slot.
     READ AT A GLANCE (2026-11-22), as Home's new sandbox reads (features/home/newSandbox/HomeNewSandbox.vue): the run's
     face and name with its percent beside them, and under them one line of where it is (the step of how many, what it is
     doing, the time left) while it runs, or what it waits for, or that it stopped, in that state's tone. -->
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
const percent = computed(() => (share.value === undefined || report?.state !== `running` ? undefined : Math.round(share.value * 100)));
// Running, the line is where it is: its place, what it is doing and what is left, in the owner's words as they came.
// Otherwise it is the state's own line (processWords.ts): what it waits for, that it stopped, that it is done.
const running = computed(() => report?.state === `running`);
const progressLine = computed(() =>
    [report?.position, report?.line, report?.remaining].filter((part): part is string => part !== undefined && part !== ``).join(` · `),
);
const statusLine = computed(() => (running.value && progressLine.value !== `` ? progressLine.value : tile.value?.note));
const statusTone = computed(() => {
    switch (report?.state) {
        case `waiting`:
            return processAsks(report) ? `font-medium text-warning` : `text-muted`;
        case `failed`:
            return `font-medium text-danger`;
        case `done`:
            return `text-success`;
        case `running`:
            return `text-content`;
        default:
            return `text-muted`;
    }
});
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
                <div class="mx-auto flex w-full max-w-xl flex-col gap-6 py-8">
                    <p v-if="report === undefined || tile === undefined" class="text-sm text-muted">{{ t(`processes.page.gone`) }}</p>
                    <template v-else>
                        <header class="flex items-start gap-4" :data-state="report.state">
                            <span class="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-content/5 text-2xl text-muted">
                                <SandboxLogo v-if="`logo` in tile.glyph" :image="null" :name="tile.glyph.logo" :size="40" />
                                <Icon v-else :name="tile.glyph.icon" aria-hidden="true" />
                            </span>
                            <div class="flex min-w-0 flex-1 flex-col gap-1">
                                <div class="flex items-baseline gap-3">
                                    <h1 class="min-w-0 flex-1 truncate text-xl font-semibold text-content">{{ tile.title }}</h1>
                                    <span v-if="percent !== undefined" class="shrink-0 font-mono text-lg tabular-nums text-muted" data-process-percent>{{ percent }}%</span>
                                </div>
                                <p class="flex items-center gap-2 text-sm" :class="statusTone" data-process-note>
                                    <Icon v-if="processLive(report) && !processAsks(report)" name="spinner" spin class="shrink-0 text-xs text-link" aria-hidden="true" />
                                    <Icon v-else-if="processAsks(report) || report.state === `failed`" name="exclamation-circle" class="shrink-0" aria-hidden="true" />
                                    {{ statusLine }}
                                </p>
                            </div>
                        </header>

                        <Meter v-if="share !== undefined" :value="share" size="md" :label="tile.title" :valuetext="statusLine" class="w-full" />

                        <div v-if="report.failure" :class="toneTint(`danger`, `soft`, `flex flex-col gap-1 rounded-lg px-4 py-3`)" data-process-failure>
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

                        <p v-if="report.state === `running`" class="border-t border-line pt-4 text-xs text-muted">{{ t(`processes.page.meanwhile`) }}</p>
                    </template>
                </div>
            </Page>
        </div>
    </section>
</template>
