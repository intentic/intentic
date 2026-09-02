<script setup lang="ts">
import {
    ArrivalHostsSchema,
    ArrivalPlanSchema,
    ArrivalReportSchema,
    type ArrivalHost,
    type ArrivalPlan,
    type ArrivalReport,
    type AssistantSource,
} from "@intentic-app/api-contract";
import { Button, Code, NoticeStack, Row, RowGroup, StatusBadge, ui, vAction } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import Checkbox from "primevue/checkbox";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { helpTopics, SOURCE_GUIDES } from "./assistantGuide";

/* THE INBOUND HALF OF <MoveCard>: one file picker, one checklist, one report — for all four things that can
 * arrive in a sandbox.
 *
 * THREE CARDS ONCE, split by ARTIFACT: "Restore from a bundle" lived on the move card, "Apply a definition" on
 * the definition card, and a whole third card asked which foreign assistant you were leaving. Read together
 * they were the same four moves on different bytes, and the differences between them were drift rather than
 * design — one of the three wrote on file pick with no preview at all, and the one that did was the bundle,
 * the only artifact that lands OVER a workspace instead of beside it.
 *
 * SO THE PICKER DOES NOT ASK WHAT THE FILE IS. The daemon can tell from two bytes and the first tar header
 * (portability/arrival.ts), and whoever is uploading already knows what they have; making them choose a button
 * for it was work with nothing on the other side. What is left is the question that actually matters, and the
 * panel asks it in the order it becomes cheap:
 *
 *   1. Is the machine already connected here? Then there is nothing to pack: one click reads it. This renders
 *      FIRST because it deletes every step below it.
 *   2. Otherwise, drop the file in — whatever it is.
 *   3. And only for the reader who has neither: which assistant, then one command to make the file.
 *
 * PREVIEW-FIRST, WHATEVER CAME IN. Every source becomes a plan, never a change: the owner unticks, and only
 * the apply writes. Credentials are a second, separate consent, and both directions now ask for it the same
 * way and in the same shape — a lock in a box, at the moment of the commit rather than standing beside it. See
 * <ExportBundleDialog> for the outbound one. */

const hosts = ref<ArrivalHost[]>([]);
const picked = ref<AssistantSource | undefined>(undefined);
const plan = ref<ArrivalPlan | undefined>(undefined);
const ticked = ref<Record<string, boolean>>({});
const withSecrets = ref(false);
const report = ref<ArrivalReport | undefined>(undefined);
const { busy: planning, notice: planError, run: runPlan } = useAsyncAction();
const { busy: applying, notice: applyError, run: runApply } = useAsyncAction();

/* Probed on mount, and again whenever the owner asks, not polled: enrolling a computer is not something that
 * happens while this panel is open, but WAKING one is. A laptop is asleep more often than not, so the row for
 * an offline machine carries its own re-check rather than making the owner reload the page to use the very
 * shortcut the panel just told them about. */
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
    // Everything applicable starts ticked at the adapter's own recommendation: an artifact is taken for its
    // whole shape far more often than for a slice, and the rows that advise against themselves say so.
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
    }, `Could not read the setup from that computer.`);

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
        // One continuous body, like the folder-drop archive route: the daemon streams it, and a bundle far
        // larger than this tab's memory never passes through it.
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
            <!-- THE OFFER THAT DELETES THE INSTRUCTIONS. A connected computer needs no archive, no transfer and
                 no file dialog, so it goes above everything and reads as the answer rather than as a shortcut.
                 EVERY CONNECTED MACHINE GETS A ROW, not only the ones holding a setup: an owner whose laptop is
                 simply ASLEEP (the ordinary state of a laptop) would otherwise see a panel that had never heard
                 of their computers and no reason to think reading one was possible at all. A row saying
                 "asleep, wake it and check again" is not a dead-end offer; it is the difference between a
                 feature that is missing and one that is waiting. -->
            <RowGroup v-if="hosts.length > 0" flat label="Your computers">
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
                            aria-label="Check this computer again"
                            v-tooltip.top="'Check again'"
                            v-action="recheck"
                        >
                            <Icon name="refresh" :spin="probing" class="text-sm" />
                        </button>
                    </template>
                </Row>
            </RowGroup>

            <!-- ONE PICKER, NO QUESTION. The daemon tells the formats apart, so the reader never declares one. -->
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
            </div>

            <!-- The last reader: neither a connected machine nor a file yet. Which assistant, then one command. -->
            <div v-if="picked === undefined" class="flex flex-wrap items-center gap-2">
                <p class="text-2xs text-subtle">Pack from</p>
                <Button label="Hermes" size="small" severity="secondary" text @click="picked = `hermes`" />
                <Button label="OpenClaw" size="small" severity="secondary" text @click="picked = `openclaw`" />
            </div>

            <!-- One command, what it prints, where the file lands. Never two commands: the reader has already
                 told us which one is theirs. -->
            <div v-else-if="guide" class="flex flex-col gap-3">
                <div class="flex items-center justify-between gap-2">
                    <p class="text-xs text-content">Run on {{ guide.label }}:</p>
                    <button type="button" :class="ui.iconButton()" aria-label="Choose a different assistant" @click="picked = undefined">
                        <Icon name="times" class="text-sm" />
                    </button>
                </div>
                <Code :code="guide.command" lang="bash" :wrap="true" :copyable="true" />

                <!-- The three cliffs, each answered where a reader hits it. Folded shut so the person whose
                     assistant runs right here never reads past the command. -->
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

        <!-- THE PLAN, and it is the same checklist whichever of the four this was. Nothing below this writes
             until Apply. -->
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

            <!-- THE SECOND CONSENT, asked on the way IN for every source, and only when the artifact actually
                 holds values (`carriesSecrets`): a definition carries secret NAMES and never a value, so asking
                 would be a question about something that is not in the file.
                 A BOX, NOT A FULL-BLEED BAND, and that is the merge's doing rather than a preference. This half
                 now sits inside a <RowNote block> on a shared card, so bleeding to the card's edge would mean
                 restating that block's padding as a negative margin here — a design token copied by hand into a
                 view, stale the day the token moves. The box also makes the pair legible: the same lock, in the
                 same frame, on the way out (<ExportBundleDialog>) and on the way in. -->
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

        <!-- THE REPORT, written once. It was three near-identical blocks with three different headings for the
             same list ("Finish the move", "Finish the arrival", "Finish the move" again). -->
        <template v-if="report">
            <div class="flex items-center gap-2">
                <StatusBadge variant="success" label="arrived" dot />
                <p class="text-2xs text-subtle">{{ report.applied.length }} item{{ report.applied.length === 1 ? `` : `s` }}.</p>
            </div>
            <!-- The failure group wears the tone its heading always did: <RowGroup>'s label is a slot precisely
                 so a group whose subject is a failure can say so without the component learning about tones. -->
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
