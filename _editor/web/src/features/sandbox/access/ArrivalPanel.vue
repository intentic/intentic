<script setup lang="ts">
import {
    ArrivalHostsSchema,
    ArrivalPlanSchema,
    ArrivalReportSchema,
    type ArrivalHost,
    type ArrivalPlan,
    type ArrivalReport,
    type AssistantSource,
} from "@intentic/api-contract";
import { Button, Code, NoticeStack, Row, RowGroup, StatusBadge, ui, vAction } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import Checkbox from "primevue/checkbox";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { helpTopics, SOURCE_GUIDES } from "../overview/assistantGuide";

// Inbound half of <MoveCard>: one picker, one checklist, one report for all four arrival sources. The daemon detects
// the source from the file itself, so the picker never asks; every source becomes a plan first, and only Apply writes.
// Credentials are a separate consent, the same lock-in-a-box as <ExportBundleDialog>'s.

const hosts = ref<ArrivalHost[]>([]);
const picked = ref<AssistantSource | undefined>(undefined);
const plan = ref<ArrivalPlan | undefined>(undefined);
const ticked = ref<Record<string, boolean>>({});
const withSecrets = ref(false);
const report = ref<ArrivalReport | undefined>(undefined);
const { busy: planning, notice: planError, run: runPlan } = useAsyncAction();
const { busy: applying, notice: applyError, run: runApply } = useAsyncAction();

// Probed on mount and on demand, never polled: enrolling happens elsewhere, but waking a sleeping laptop happens right
// here, so an offline row carries its own recheck instead of a page reload.
const probing = ref(false);
const probe = async (): Promise<void> => {
    if (probing.value) {
        return;
    }
    probing.value = true;
    try {
        hosts.value = ArrivalHostsSchema.parse(await sandboxJson(`/arrivals/hosts`).catch(() => ({ hosts: [] }))).hosts;
    } finally {
        probing.value = false;
    }
};
const recheck = (): Promise<void> => probe();
onMounted(probe);

const ready = computed(() => hosts.value.filter((host) => host.found !== undefined));
const guide = computed(() => (picked.value === undefined ? undefined : SOURCE_GUIDES[picked.value]));
const help = computed(() => (guide.value === undefined ? [] : helpTopics(guide.value)));

// The badge over the checklist: what the daemon decided it was reading, in the reader's own word for it.
const SOURCE_LABELS: Record<ArrivalPlan["source"], string> = {
    definition: `sandbox.toml`,
    bundle: `environment bundle`,
    hermes: `hermes`,
    openclaw: `openclaw`,
};

const adopt = (parsed: ArrivalPlan): void => {
    plan.value = parsed;
    // Starts ticked at the adapter's own recommendation; a row advising against itself says so.
    ticked.value = Object.fromEntries(parsed.items.filter((item) => item.applicable).map((item) => [item.id, item.recommended]));
    withSecrets.value = false;
    report.value = undefined;
};

// The zero-packing path: the daemon walks the machine's own folder over the socket it already holds.
const readFromHost = (host: ArrivalHost): Promise<void> =>
    runPlan(async () => {
        adopt(
            ArrivalPlanSchema.parse(
                await sandboxJson(`/arrivals/scan`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({ host: host.id }),
                }),
            ),
        );
    }, `Could not read the setup from that device.`);

const chooseFile = ref<HTMLInputElement>();
const readFile = (event: Event): Promise<void> =>
    runPlan(async () => {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = ``;
        if (file === undefined) {
            return;
        }
        report.value = undefined;
        // Streamed as one body, like the folder-drop route; a huge bundle never passes through this tab's memory.
        adopt(ArrivalPlanSchema.parse(await sandboxJson(`/arrivals/plan`, { method: `POST`, body: file, duplex: `half` } as RequestInit)));
    }, `Could not read that file.`);

const tickedCount = computed(() => Object.values(ticked.value).filter(Boolean).length);

const apply = (): Promise<void> =>
    runApply(async () => {
        const held = plan.value;
        if (held === undefined) {
            return;
        }
        const items = held.items.filter((item) => ticked.value[item.id] === true).map((item) => item.id);
        report.value = ArrivalReportSchema.parse(
            await sandboxJson(`/arrivals/apply`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ token: held.token, items, includeSecrets: withSecrets.value }),
            }),
        );
        plan.value = undefined;
        picked.value = undefined;
    }, `Could not bring that in.`);

const cancel = (): Promise<void> =>
    runPlan(async () => {
        await sandboxJson(`/arrivals`, { method: `DELETE` });
        plan.value = undefined;
        picked.value = undefined;
        report.value = undefined;
    }, `Could not discard the plan.`);
</script>

<template>
    <div class="flex flex-col gap-4">
        <template v-if="plan === undefined">
            <!--
                Connected devices go first, since a connected machine needs no archive or file dialog. Every connected machine gets a row, even
                asleep ones, so an offline device reads as waiting, not unsupported.
            -->
            <RowGroup v-if="hosts.length > 0" flat label="Your devices">
                <Row
                    v-for="host in hosts"
                    :key="host.id"
                    :icon="host.found === undefined ? `desktop` : `check`"
                    :tone="host.found === undefined ? `default` : `success`"
                >
                    <template #title
                        ><span class="text-xs">{{
                            host.found === undefined ? host.id : `Found a ${host.found === `hermes` ? `Hermes` : `OpenClaw`} setup on ${host.id}`
                        }}</span></template
                    >
                    <template v-if="host.found === undefined" #description>{{ host.detail }}</template>
                    <template #control>
                        <Button v-if="host.found !== undefined" label="Bring it in" size="small" :loading="planning" @click="readFromHost(host)" />
                        <button
                            v-else
                            type="button"
                            :class="ui.iconButton()"
                            aria-label="Check this device again"
                            v-tooltip.top="'Check again'"
                            v-action="recheck"
                        >
                            <Icon name="refresh" :spin="probing" class="text-sm" />
                        </button>
                    </template>
                </Row>
            </RowGroup>

            <!-- One picker, no format question: the daemon tells the formats apart. -->
            <div class="flex flex-wrap items-center gap-2">
                <Button
                    :label="ready.length > 0 ? `Or choose a file` : `Choose a file`"
                    size="small"
                    :loading="planning"
                    @click="chooseFile?.click()"
                >
                    <template #icon><Icon name="upload" /></template>
                </Button>
                <input
                    ref="chooseFile"
                    type="file"
                    accept=".toml,.gz,.tgz,text/plain,application/toml,application/gzip"
                    class="hidden"
                    @change="readFile"
                />
                <template v-if="picked === undefined">
                    <p class="text-2xs text-subtle">Pack from</p>
                    <Button label="Hermes" size="small" severity="secondary" text @click="picked = `hermes`" />
                    <Button label="OpenClaw" size="small" severity="secondary" text @click="picked = `openclaw`" />
                </template>
            </div>

            <!-- One command only: the reader already named which assistant is theirs. -->
            <div v-if="guide" class="flex flex-col gap-3">
                <div class="flex items-center justify-between gap-2">
                    <p class="text-xs text-content">Run on {{ guide.label }}:</p>
                    <button type="button" :class="ui.iconButton()" aria-label="Choose a different assistant" @click="picked = undefined">
                        <Icon name="times" class="text-sm" />
                    </button>
                </div>
                <Code :code="guide.command" lang="bash" :wrap="true" :copyable="true" />

                <!-- Folded shut by default, so a reader whose command just works never reads past it. -->
                <div class="flex flex-col gap-1">
                    <details v-for="topic in help" :key="topic.title" class="text-2xs">
                        <summary class="cursor-pointer text-subtle">{{ topic.title }}</summary>
                        <div class="mt-1 flex flex-col gap-1 pb-1">
                            <p class="text-subtle">{{ topic.body }}</p>
                            <Code v-if="topic.command" :code="topic.command" lang="bash" :wrap="true" :copyable="true" />
                        </div>
                    </details>
                    <details v-if="guide.fallbackCommand" class="text-2xs">
                        <summary class="cursor-pointer text-subtle">That command isn't available</summary>
                        <div class="mt-1 flex flex-col gap-1 pb-1">
                            <p class="text-subtle">{{ guide.fallbackNote }}</p>
                            <Code :code="guide.fallbackCommand" lang="bash" :wrap="true" :copyable="true" />
                        </div>
                    </details>
                </div>
            </div>
        </template>

        <!-- Same checklist regardless of source; nothing below writes until Apply. -->
        <template v-else>
            <div class="flex items-center gap-2">
                <StatusBadge variant="info" :label="plan.name ?? SOURCE_LABELS[plan.source]" />
            </div>
            <RowGroup flat label="What would land">
                <Row
                    v-for="item in plan.items"
                    :key="item.id"
                    :as="item.applicable ? `label` : `div`"
                    :class="item.applicable ? `cursor-pointer` : `opacity-60`"
                >
                    <template #title
                        ><span class="text-xs">{{ item.label }}</span></template
                    >
                    <template #description>{{ item.applicable ? item.detail : item.reason }}</template>
                    <template #meta>
                        <StatusBadge v-if="!item.applicable" variant="info" label="already here" />
                        <StatusBadge v-else-if="item.secrets.length > 0" variant="warning" label="secret" />
                        <StatusBadge v-else-if="!item.recommended" variant="info" label="check first" />
                    </template>
                    <template #control>
                        <Checkbox v-if="item.applicable" v-model="ticked[item.id]" binary />
                    </template>
                </Row>
            </RowGroup>

            <!--
                Asked only when the plan actually carries secret values, not just names. Boxed, not full-bleed, since the shared card's RowNote block
                already owns the padding; matches the export dialog's own lock-in-a-box.
            -->
            <div v-if="plan.carriesSecrets" class="overflow-hidden rounded-lg border border-line">
                <Row
                    flush
                    as="label"
                    density="compact"
                    :icon="withSecrets ? `unlock` : `lock`"
                    :tone="withSecrets ? `warning` : `default`"
                    title="Take the secret values too"
                    class="cursor-pointer px-3.5 py-3"
                >
                    <template #control>
                        <ToggleSwitch v-model="withSecrets" />
                    </template>
                </Row>
            </div>

            <RowGroup v-if="plan.needsAction.length > 0" flat label="Won't happen by itself">
                <Row v-for="action in plan.needsAction" :key="action.subject" :title="action.subject" :description="action.detail" />
            </RowGroup>

            <details v-if="plan.refused.length > 0" class="text-2xs text-subtle">
                <summary class="cursor-pointer">
                    {{ plan.refused.length }} thing{{ plan.refused.length === 1 ? `` : `s` }} stay{{ plan.refused.length === 1 ? `s` : `` }} behind on
                    purpose
                </summary>
                <ul class="mt-1 flex list-disc flex-col gap-0.5 pl-4">
                    <li v-for="line in plan.refused" :key="line">{{ line }}</li>
                </ul>
            </details>

            <div class="flex flex-wrap items-center gap-2">
                <Button
                    :label="`Bring in ${tickedCount} item${tickedCount === 1 ? `` : `s`}`"
                    size="small"
                    :loading="applying"
                    :disabled="tickedCount === 0"
                    @click="apply"
                />
                <Button label="Cancel" size="small" severity="secondary" text @click="cancel" />
            </div>
        </template>

        <!-- One shared report for all four sources. -->
        <template v-if="report">
            <div class="flex items-center gap-2">
                <StatusBadge variant="success" label="arrived" dot />
                <p class="text-2xs text-subtle">{{ report.applied.length }} item{{ report.applied.length === 1 ? `` : `s` }}.</p>
            </div>
            <!-- Label is a slot so a failure group can wear its own tone without RowGroup knowing about tones. -->
            <RowGroup v-if="report.failed.length > 0" flat>
                <template #label><span :class="ui.sectionLabel(`text-danger`)">Didn't land</span></template>
                <Row v-for="failure in report.failed" :key="failure.id" :title="failure.label" :description="failure.error" />
            </RowGroup>
            <RowGroup v-if="report.needsAction.length > 0" flat label="Finish the arrival">
                <Row v-for="action in report.needsAction" :key="action.subject" :title="action.subject" :description="action.detail" />
            </RowGroup>
            <p v-if="report.refused.length > 0" class="text-2xs text-warning">{{ report.refused.length }} refused.</p>
        </template>

        <NoticeStack :of="[planError, applyError]" />
    </div>
</template>
