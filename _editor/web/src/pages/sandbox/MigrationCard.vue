<script setup lang="ts">
import { MigrationPlanSchema, MigrationReportSchema, type MigrationPlan, type MigrationReport } from "@intentic-app/api-contract";
import { Card, NoticeStack, Row, RowGroup, StatusBadge } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { useSandbox } from "../../composables/sandbox/useSandbox";

/* ARRIVING FROM ANOTHER ASSISTANT — a packed `~/.hermes` uploaded, previewed as a ticked checklist, applied as
 * native pieces (docs/assistant-import-design.md; daemon side in _sandbox/sandbox/src/migrations/).
 *
 * PREVIEW-FIRST IS THE WHOLE CARD. The upload answers with a plan, not with changes: every item arrives with
 * the adapter's default tick (`recommended`), the owner edits, and only the apply writes. Secrets are a second,
 * separate consent — the same lock-row anatomy as the bundle card beside this one, because it is the same
 * decision. The plan lives on the daemon under a token and dies with a cancel, an apply, or a daemon restart;
 * this card holds nothing but the rendering, so re-uploading after any staleness costs seconds.
 *
 * The report is the deliverable, exactly as a bundle restore's is: what landed, what failed and why, and the
 * `needsAction` list — channels to reconnect, logins that never travel — that makes "seamless" honest. */

const isOwner = computed(() => useSandbox().active.value?.role === `owner`);

const plan = ref<MigrationPlan | undefined>(undefined);
const ticked = ref<Record<string, boolean>>({});
const withSecrets = ref(false);
const report = ref<MigrationReport | undefined>(undefined);
const { busy: planning, notice: planError, run: runPlan } = useAsyncAction();
const { busy: applying, notice: applyError, run: runApply } = useAsyncAction();

const chooseArchive = ref<HTMLInputElement>();
const uploadArchive = (event: Event): Promise<void> =>
    runPlan(async () => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file === undefined) {
            return;
        }
        report.value = undefined;
        const parsed = MigrationPlanSchema.parse(
            await sandboxJson(`/migrations/plan`, { method: `POST`, body: file, duplex: `half` } as RequestInit),
        );
        plan.value = parsed;
        ticked.value = Object.fromEntries(parsed.items.map((item) => [item.id, item.recommended]));
        withSecrets.value = false;
    }, `Could not read that archive.`);

// Stable reading order — what the agent will know, then what runs, then what connects, then the keys.
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
    }, `Could not apply the import.`);

const cancel = (): Promise<void> =>
    runPlan(async () => {
        await sandboxJson(`/migrations`, { method: `DELETE` });
        plan.value = undefined;
        report.value = undefined;
    }, `Could not discard the plan.`);
</script>

<template>
    <Card class="flex flex-col gap-4">
        <Row
            flush
            :heading="2"
            icon="upload"
            title="Arrive from another assistant"
            description="Bring a Hermes setup here: its personality and memory, skills, scheduled jobs and connections land as ordinary pieces of this sandbox — previewed as a checklist before anything is written."
        />

        <template v-if="isOwner">
            <!-- Idle: the one gesture, and the exact command that produces its input. -->
            <div v-if="plan === undefined" class="flex flex-wrap items-center gap-2">
                <Button label="Upload a Hermes setup" size="small" :loading="planning" @click="chooseArchive?.click()">
                    <template #icon><Icon name="upload" /></template>
                </Button>
                <input ref="chooseArchive" type="file" accept=".gz,.tgz,application/gzip" class="hidden" @change="uploadArchive" />
                <code class="font-mono text-2xs text-subtle">tar czf hermes-setup.tar.gz -C ~ .hermes</code>
            </div>

            <!-- The plan: every item a row with its tick. Nothing below this writes until Apply. -->
            <template v-else>
                <RowGroup>
                    <Row v-for="item in orderedItems" :key="item.id" as="label" density="compact" class="cursor-pointer">
                        <template #title
                            ><span class="text-xs">{{ item.label }}</span></template
                        >
                        <template v-if="item.detail" #description>{{ item.detail }}</template>
                        <template #meta>
                            <StatusBadge v-if="item.secrets.length > 0" variant="warning" label="Secret" />
                            <StatusBadge v-if="!item.recommended" variant="info" label="Check first" />
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

                <div v-if="plan.needsAction.length > 0" class="flex flex-col gap-2 rounded-lg border border-line p-3">
                    <p class="text-xs font-medium text-content">Won't move by itself</p>
                    <div v-for="action in plan.needsAction" :key="action.subject" class="text-2xs">
                        <p class="font-medium text-content">{{ action.subject }}</p>
                        <p class="text-subtle">{{ action.detail }}</p>
                    </div>
                </div>

                <details v-if="plan.refused.length > 0" class="text-2xs text-subtle">
                    <summary class="cursor-pointer">{{ plan.refused.length }} things stay behind on purpose</summary>
                    <ul class="mt-1 flex list-disc flex-col gap-0.5 pl-4">
                        <li v-for="line in plan.refused" :key="line">{{ line }}</li>
                    </ul>
                </details>

                <div class="flex flex-wrap items-center gap-2">
                    <Button
                        :label="`Import ${tickedCount} item${tickedCount === 1 ? '' : 's'}`"
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

        <!-- The fidelity report — what landed, what did not and why, and what still needs a person. -->
        <template v-if="report">
            <div class="flex items-center gap-2">
                <StatusBadge variant="success" label="Imported" dot />
                <p class="text-2xs text-subtle">{{ report.applied.length }} item{{ report.applied.length === 1 ? `` : `s` }} landed.</p>
            </div>
            <div v-if="report.failed.length > 0" class="flex flex-col gap-2 rounded-lg border border-line p-3">
                <p class="text-xs font-medium text-danger">Didn't land</p>
                <div v-for="failure in report.failed" :key="failure.id" class="text-2xs">
                    <p class="font-medium text-content">{{ failure.label }}</p>
                    <p class="text-subtle">{{ failure.error }}</p>
                </div>
            </div>
            <div v-if="report.needsAction.length > 0" class="flex flex-col gap-2 rounded-lg border border-line p-3">
                <p class="text-xs font-medium text-content">Finish the move</p>
                <div v-for="action in report.needsAction" :key="action.subject" class="text-2xs">
                    <p class="font-medium text-content">{{ action.subject }}</p>
                    <p class="text-subtle">{{ action.detail }}</p>
                </div>
            </div>
        </template>

        <NoticeStack :of="[planError, applyError]" />
    </Card>
</template>
