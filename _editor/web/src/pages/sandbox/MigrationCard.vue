<script setup lang="ts">
import {
    MigrationHostsSchema,
    MigrationPlanSchema,
    MigrationReportSchema,
    type MigrationHost,
    type MigrationPlan,
    type MigrationReport,
    type MigrationSource,
} from "@intentic-app/api-contract";
import { Button, Code, NoticeStack, Row, RowGroup, StatusBadge, ui, vAction } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import Checkbox from "primevue/checkbox";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { useRole } from "../../composables/sandbox/useRole";
import { helpTopics, SOURCE_GUIDES } from "./migrationGuide";

/* ARRIVING FROM ANOTHER ASSISTANT: a Hermes or OpenClaw setup read in, previewed as a ticked checklist, and
 * applied as native pieces (docs/assistant-import-design.md; daemon side in _sandbox/sandbox/src/migrations/).
 *
 * THE CARD'S REAL SUBJECT IS "WHERE IS YOUR SETUP", not "upload a file", and that reordering is the whole
 * design. The first version was one button under a grey line holding both tools' archive commands, which is
 * only an instruction if you already have a shell on the machine the assistant runs on. Most people do not:
 * these tools live on a VPS reached over a tunnel, or in a container, and the browser reading this is
 * somewhere else entirely. So the card asks the question in that order:
 *
 *   1. Is the machine already connected here? Then there is nothing to pack: one click reads it. This is the
 *      answer the whole flow is built around, and it renders FIRST because it deletes every step below it.
 *   2. Otherwise: which tool? One question with an answer nobody has to look up.
 *   3. Then exactly one command, with what it prints and where the file lands, and the three ways this
 *      actually goes wrong (a server, a container, a moved folder) folded underneath, each answered in place.
 *
 * PREVIEW-FIRST SURVIVES BOTH DOORS. Whichever way the setup arrives it becomes a plan, never a change: every
 * item carries the adapter's default tick, the operator edits, and only the apply writes. Secrets are a second,
 * separate consent. The report at the end is the deliverable, exactly as a bundle restore's is. */

const { canShip: canOperate } = useRole();

const hosts = ref<MigrationHost[]>([]);
const picked = ref<MigrationSource | undefined>(undefined);
const plan = ref<MigrationPlan | undefined>(undefined);
const ticked = ref<Record<string, boolean>>({});
const withSecrets = ref(false);
const report = ref<MigrationReport | undefined>(undefined);
const { busy: planning, notice: planError, run: runPlan } = useAsyncAction();
const { busy: applying, notice: applyError, run: runApply } = useAsyncAction();

/* Probed on mount, and again whenever the owner asks, not polled: enrolling a computer is not something that
 * happens while this card is open, but WAKING one is. A laptop is asleep more often than not, so the row for
 * an offline machine carries its own re-check rather than making the owner reload the page to use the very
 * shortcut the card just told them about.
 *
 * `probed` gates the no-computers sentence: before the first answer, "you have no computers connected" would
 * be a claim about a request that has not come back yet. */
const probed = ref(false);
const probing = ref(false);
const probe = async (): Promise<void> => {
    if (!canOperate.value || probing.value) {
        return;
    }
    probing.value = true;
    try {
        hosts.value = MigrationHostsSchema.parse(await sandboxJson(`/migrations/hosts`).catch(() => ({ hosts: [] }))).hosts;
        probed.value = true;
    } finally {
        probing.value = false;
    }
};
const recheck = (): Promise<void> => probe();
onMounted(probe);

const ready = computed(() => hosts.value.filter((host) => host.found !== undefined));
const guide = computed(() => (picked.value === undefined ? undefined : SOURCE_GUIDES[picked.value]));
const help = computed(() => (guide.value === undefined ? [] : helpTopics(guide.value)));

const adopt = (parsed: MigrationPlan): void => {
    plan.value = parsed;
    ticked.value = Object.fromEntries(parsed.items.map((item) => [item.id, item.recommended]));
    withSecrets.value = false;
    report.value = undefined;
};

// The zero-packing path: the daemon walks the machine's own folder over the socket it already holds.
const readFromHost = (host: MigrationHost): Promise<void> =>
    runPlan(async () => {
        adopt(
            MigrationPlanSchema.parse(
                await sandboxJson(`/migrations/scan`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({ host: host.id }),
                }),
            ),
        );
    }, `Could not read the setup from that computer.`);

const chooseArchive = ref<HTMLInputElement>();
const uploadArchive = (event: Event): Promise<void> =>
    runPlan(async () => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file === undefined) {
            return;
        }
        report.value = undefined;
        adopt(MigrationPlanSchema.parse(await sandboxJson(`/migrations/plan`, { method: `POST`, body: file, duplex: `half` } as RequestInit)));
    }, `Could not read that archive.`);

// Stable reading order: what the agent will know, then what runs, then what connects, then the keys.
const TARGET_ORDER = [`memory`, `skill`, `automation`, `capability`, `file`, `secret`] as const;
const orderedItems = computed(() =>
    (plan.value?.items ?? []).toSorted((left, right) => TARGET_ORDER.indexOf(left.target) - TARGET_ORDER.indexOf(right.target)),
);
const anySecrets = computed(() => (plan.value?.items ?? []).some((item) => item.secrets.length > 0));
const tickedCount = computed(() => Object.values(ticked.value).filter(Boolean).length);

const apply = (): Promise<void> =>
    runApply(async () => {
        const held = plan.value;
        if (held === undefined) {
            return;
        }
        const items = held.items.filter((item) => ticked.value[item.id] === true).map((item) => item.id);
        report.value = MigrationReportSchema.parse(
            await sandboxJson(`/migrations/apply`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ token: held.token, items, includeSecrets: withSecrets.value }),
            }),
        );
        plan.value = undefined;
        picked.value = undefined;
    }, `Could not apply the import.`);

const cancel = (): Promise<void> =>
    runPlan(async () => {
        await sandboxJson(`/migrations`, { method: `DELETE` });
        plan.value = undefined;
        picked.value = undefined;
        report.value = undefined;
    }, `Could not discard the plan.`);
</script>

<template>
    <RowGroup label="Arrive from another assistant">
        <div class="flex flex-col gap-4 p-5">
        <template v-if="canOperate">
            <template v-if="plan === undefined">
                <!-- THE OFFER THAT DELETES THE INSTRUCTIONS. A connected computer needs no archive, no
                     transfer and no file dialog, so it goes above everything and reads as the answer rather
                     than as a shortcut.
                     EVERY CONNECTED MACHINE GETS A ROW, not only the ones holding a setup, and that is a
                     correction: the first cut rendered nothing unless a setup was found, so an owner whose
                     laptop was simply ASLEEP (the ordinary state of a laptop) saw a card that had never
                     heard of their computers and no reason to think reading one was possible at all. A row
                     saying \"asleep, wake it and check again\" is not a dead-end offer; it is the difference
                     between a feature that is missing and one that is waiting. -->
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
                            <Button
                                v-if="host.found !== undefined"
                                label="Bring it in"
                                size="small"
                                :loading="planning"
                                @click="readFromHost(host)"
                            />
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

                <!-- Step 1, and it is a question rather than a form: which tool you run is the one thing you
                     never have to look up, and answering it halves everything below. -->
                <div v-if="picked === undefined" class="flex flex-col gap-2">
                    <p class="text-xs text-content">{{ ready.length > 0 ? `Somewhere else?` : `Which one are you moving?` }}</p>
                    <div class="flex flex-wrap items-center gap-2">
                        <Button label="Hermes" size="small" severity="secondary" @click="picked = `hermes`" />
                        <Button label="OpenClaw" size="small" severity="secondary" @click="picked = `openclaw`" />
                    </div>
                </div>

                <!-- Step 2: one command, what it prints, where the file lands, then the picker. Never two
                     commands: the reader has already told us which one is theirs. -->
                <div v-else-if="guide" class="flex flex-col gap-3">
                    <div class="flex items-center justify-between gap-2">
                        <p class="text-xs text-content">1. Run this where {{ guide.label }} lives:</p>
                        <button type="button" :class="ui.iconButton()" aria-label="Choose a different assistant" @click="picked = undefined">
                            <Icon name="times" class="text-sm" />
                        </button>
                    </div>
                    <Code :code="guide.command" lang="bash" :wrap="true" :copyable="true" />
                    <p class="text-2xs text-subtle">{{ guide.lands }}</p>

                    <p class="text-xs text-content">2. Pick that file:</p>
                    <div class="flex flex-wrap items-center gap-2">
                        <Button label="Choose the packed file" size="small" :loading="planning" @click="chooseArchive?.click()">
                            <template #icon><Icon name="upload" /></template>
                        </Button>
                        <input ref="chooseArchive" type="file" accept=".gz,.tgz,application/gzip" class="hidden" @change="uploadArchive" />
                    </div>

                    <!-- The three cliffs, each answered where a reader hits it. Folded shut so the person
                         whose assistant runs right here never reads past step 2. -->
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

                    <!-- Said BEFORE the file exists, not after: a tarball of somebody's keys lives in
                         Downloads forever if nobody mentions it while they are still thinking about it. -->
                    <p class="text-2xs text-warning">That file holds your keys. Delete it once the import is done.</p>
                </div>
            </template>

            <!-- The plan: every item a row with its tick. Nothing below this writes until Apply. -->
            <template v-else>
                <div class="flex items-center gap-2">
                    <StatusBadge variant="info" :label="plan.source === `hermes` ? `hermes` : `openclaw`" />
                    <p class="text-2xs text-subtle">Untick anything you don't want. Nothing is written until you import.</p>
                </div>
                <RowGroup flat label="What would come in">
                    <Row v-for="item in orderedItems" :key="item.id" as="label" class="cursor-pointer">
                        <template #title
                            ><span class="text-xs">{{ item.label }}</span></template
                        >
                        <template v-if="item.detail" #description>{{ item.detail }}</template>
                        <template #meta>
                            <StatusBadge v-if="item.secrets.length > 0" variant="warning" label="secret" />
                            <StatusBadge v-if="!item.recommended" variant="info" label="check first" />
                        </template>
                        <template #control>
                            <Checkbox v-model="ticked[item.id]" binary />
                        </template>
                    </Row>
                </RowGroup>

                <!-- The second consent, same anatomy as the bundle card's lock row: values move only when this
                     is on; off, the keyed items stay behind and connections land keyless, and the report says
                     so instead of pretending. -->
                <div v-if="anySecrets" class="-mx-5 border-y border-line">
                    <Row
                        flush
                        as="label"
                        density="compact"
                        :icon="withSecrets ? `unlock` : `lock`"
                        :tone="withSecrets ? `warning` : `default`"
                        title="Move secret values too"
                        description="API keys and tokens from the old setup's files, stored into this sandbox's secret stores. Leave this off to bring everything else and enter keys by hand."
                        class="cursor-pointer px-5 py-2.5"
                    >
                        <template #control>
                            <ToggleSwitch v-model="withSecrets" />
                        </template>
                    </Row>
                </div>

                <RowGroup v-if="plan.needsAction.length > 0" flat label="Won't move by itself">
                    <Row v-for="action in plan.needsAction" :key="action.subject" :title="action.subject" :description="action.detail" />
                </RowGroup>

                <details v-if="plan.refused.length > 0" class="text-2xs text-subtle">
                    <summary class="cursor-pointer">
                        {{ plan.refused.length }} thing{{ plan.refused.length === 1 ? `` : `s` }} stay{{ plan.refused.length === 1 ? `s` : `` }}
                        behind on purpose
                    </summary>
                    <ul class="mt-1 flex list-disc flex-col gap-0.5 pl-4">
                        <li v-for="line in plan.refused" :key="line">{{ line }}</li>
                    </ul>
                </details>

                <div class="flex flex-wrap items-center gap-2">
                    <Button
                        :label="`Import ${tickedCount} item${tickedCount === 1 ? `` : `s`}`"
                        size="small"
                        :loading="applying"
                        :disabled="tickedCount === 0"
                        @click="apply"
                    />
                    <Button label="Cancel" size="small" severity="secondary" text @click="cancel" />
                </div>
            </template>
        </template>
        <p v-else class="text-2xs text-subtle">Only the sandbox owner can import a setup.</p>

        <!-- The fidelity report: what landed, what did not and why, and what still needs a person. -->
        <template v-if="report">
            <div class="flex items-center gap-2">
                <StatusBadge variant="success" label="imported" dot />
                <p class="text-2xs text-subtle">{{ report.applied.length }} item{{ report.applied.length === 1 ? `` : `s` }} landed.</p>
            </div>
            <RowGroup v-if="report.failed.length > 0" flat>
                <template #label><span :class="ui.sectionLabel(`text-danger`)">Didn't land</span></template>
                <Row v-for="failure in report.failed" :key="failure.id" :title="failure.label" :description="failure.error" />
            </RowGroup>
            <RowGroup v-if="report.needsAction.length > 0" flat label="Finish the move">
                <Row v-for="action in report.needsAction" :key="action.subject" :title="action.subject" :description="action.detail" />
            </RowGroup>
        </template>

        <NoticeStack :of="[planError, applyError]" />
        </div>
    </RowGroup>
</template>
