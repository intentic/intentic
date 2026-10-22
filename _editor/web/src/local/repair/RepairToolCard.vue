<script setup lang="ts">
import { Button, CopyButton, Icon, type Tone, toneInk, toneRim, toneTint, toneWash, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import type { LocalRepairTool } from "../../app/environments/localHost";
import { checkLook, type DoctorCheck, type DoctorReport, type EngineReport, engineTone, readTool, toolLook } from "./repairSession";

// ONE THING REPAIR DID, as a card: what it is, where it stands, and what it found, read into rows (a doctor's checks,
// the engine's state) rather than the text `ic` printed, which stays one press away under "Raw output". A change that
// waits for the reader carries its Allow and Deny here, on the card that names it.

const { tool, answer } = defineProps<{
    tool: LocalRepairTool;
    /** The reader's Allow or Deny, awaited: the pressed button holds until the app has it, so a second press can't land. */
    answer: (allow: boolean) => Promise<void>;
}>();

const t = useT();
const look = computed(() => toolLook(tool));
const reading = computed(() => readTool(tool));
const showRaw = ref(false);
// Raw output only where the card shows something else: a short answer already stands on it, word for word.
const hasRaw = computed(() => (tool.detail?.trim() ?? ``) !== `` && reading.value.kind !== `text`);
const asking = computed(() => tool.state === `needsApproval` && tool.approvalId !== undefined);

const problemsOf = (report: DoctorReport): DoctorCheck[] =>
    report.checks.filter((check) => check.state === `fail` || check.state === `warn` || check.state === `fixing`);
const restOf = (report: DoctorReport): DoctorCheck[] => report.checks.filter((check) => check.state === `ok` || check.state === `skip`);

// The line under the card's name: where it stands, and once done, what it amounts to.
const stateLine = computed((): string => {
    switch (tool.state) {
        case `running`:
            return t(`local.repair.tool.running`);
        case `needsApproval`:
            return t(`local.repair.tool.needsApproval`);
        case `refused`:
            return t(`local.repair.tool.refused`);
        case `failed`:
            return t(`local.repair.tool.failed`);
        case `done`:
            break;
    }
    const read = reading.value;
    if (read.kind === `doctor`) {
        const checks = read.reports.flatMap((report) => report.checks);
        const problems = checks.filter((check) => check.state === `fail` || check.state === `warn`).length;
        return problems === 0
            ? t(`local.repair.tool.allPassed`, { count: checks.length }, checks.length)
            : t(`local.repair.tool.needAttention`, { count: problems, total: checks.length }, problems);
    }
    return t(`local.repair.tool.done`);
});

// How a doctor's run ended, as a pill; an outcome this page does not know draws none.
const outcomePill = (outcome: string | undefined): { readonly tone: Tone; readonly label: string } | undefined => {
    switch (outcome) {
        case `healthy`:
            return { tone: `success`, label: t(`local.repair.outcome.healthy`) };
        case `fixed`:
            return { tone: `success`, label: t(`local.repair.outcome.fixed`) };
        case `needs-you`:
            return { tone: `warning`, label: t(`local.repair.outcome.needsYou`) };
        case `failed`:
            return { tone: `danger`, label: t(`local.repair.outcome.failed`) };
        default:
            return undefined;
    }
};

const whoFixes = (check: DoctorCheck): string | undefined => {
    switch (check.fix) {
        case `auto`:
            return t(`local.repair.who.auto`);
        case `consent`:
            return t(`local.repair.who.consent`);
        case `you`:
            return t(`local.repair.who.you`);
        case undefined:
            return undefined;
    }
};

// `ic` words a problem to follow a check's name ("the container is stopped."); standing on its own line it opens a sentence.
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// A remedy that is a command reads as one; anything else is a sentence.
const isCommand = (remedy: string): boolean => /^(ic|docker|wsl)\s/.test(remedy);

const engineName = (engine: EngineReport): string =>
    ({
        intentic: t(`local.repair.engine.intentic`),
        dockerDesktop: t(`local.repair.engine.dockerDesktop`),
        native: t(`local.repair.engine.native`),
    })[engine.engine] ?? engine.engine;
const engineState = (engine: EngineReport): string => {
    if (!engine.installed) {
        return t(`local.repair.engine.notInstalled`);
    }
    if (engine.running) {
        return t(`local.repair.engine.running`);
    }
    return engine.held ? t(`local.repair.engine.held`) : t(`local.repair.engine.stopped`);
};
</script>

<template>
    <article class="overflow-hidden rounded-xl border bg-card" :class="toneRim(asking ? `warning` : `neutral`, asking ? `strong` : `soft`)">
        <header class="flex items-center gap-3 px-4 py-3">
            <span class="grid size-8 shrink-0 place-items-center rounded-full" :class="toneWash(look.tone)">
                <Icon :name="look.icon" :spin="tool.state === `running`" class="text-sm" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-content">{{ tool.summary }}</p>
                <p class="text-xs" :class="tool.state === `failed` ? toneInk(`danger`) : `text-muted`">{{ stateLine }}</p>
            </div>
            <button
                v-if="hasRaw"
                type="button"
                :class="ui.textButton({ size: `xs`, tone: `quiet` })"
                :aria-expanded="showRaw"
                class="shrink-0"
                @click="showRaw = !showRaw"
            >
                <Icon name="code" class="text-2xs" aria-hidden="true" />
                {{ showRaw ? t(`local.repair.hideRaw`) : t(`local.repair.showRaw`) }}
            </button>
        </header>

        <!-- A change waiting on the reader: what it is, that nothing happens without them, and the two answers. -->
        <div v-if="asking" class="flex flex-wrap items-center gap-3 border-t px-4 py-3" :class="toneTint(`warning`, `soft`)">
            <p class="min-w-0 flex-1 text-xs text-muted">{{ t(`local.repair.askBody`) }}</p>
            <div class="flex shrink-0 gap-2">
                <Button size="small" tier="quiet" :label="t(`local.repair.deny`)" @click="answer(false)" />
                <Button size="small" tier="accent" :label="t(`local.repair.allow`)" @click="answer(true)">
                    <template #icon><Icon name="check" aria-hidden="true" /></template>
                </Button>
            </div>
        </div>

        <!-- What a doctor found: the problems as rows with their remedy, everything fine as a line of chips. -->
        <div v-else-if="reading.kind === `doctor`" class="flex flex-col gap-3 border-t border-line-subtle px-4 py-3">
            <section v-for="report in reading.reports" :key="report.slug" class="flex flex-col gap-2">
                <div v-if="report.slug !== `` || outcomePill(report.outcome) !== undefined" class="flex items-center gap-2">
                    <Icon name="box" class="text-xs text-subtle" aria-hidden="true" />
                    <span class="min-w-0 truncate font-mono text-xs text-content">{{ report.slug || t(`local.repair.thisPc`) }}</span>
                    <span v-if="report.asleep" class="rounded-full px-2 py-0.5 text-2xs" :class="toneWash(`neutral`)">{{
                        t(`local.repair.asleep`)
                    }}</span>
                    <span
                        v-if="outcomePill(report.outcome)"
                        class="ml-auto rounded-full px-2 py-0.5 text-2xs font-medium"
                        :class="toneWash(outcomePill(report.outcome)?.tone ?? `neutral`)"
                    >
                        {{ outcomePill(report.outcome)?.label }}
                    </span>
                </div>
                <ul v-if="problemsOf(report).length > 0" class="flex flex-col gap-1.5">
                    <li
                        v-for="check in problemsOf(report)"
                        :key="check.id"
                        class="flex items-start gap-2.5 rounded-lg border bg-canvas px-3 py-2"
                        :class="toneRim(checkLook(check.state).tone, `soft`)"
                    >
                        <Icon
                            :name="checkLook(check.state).icon"
                            :spin="check.state === `fixing`"
                            class="shrink-0 text-sm"
                            :class="toneInk(checkLook(check.state).tone)"
                            aria-hidden="true"
                        />
                        <div class="flex min-w-0 flex-1 flex-col gap-1">
                            <p class="text-xs font-medium text-content">{{ check.label }}</p>
                            <p v-if="check.problem" class="text-xs text-muted">{{ sentence(check.problem) }}</p>
                            <p v-if="check.remedy" class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                                <span class="text-subtle">{{ t(`local.repair.remedy`) }}</span>
                                <code v-if="isCommand(check.remedy)" class="rounded bg-overlay px-1.5 py-0.5 font-mono text-2xs text-content">{{
                                    check.remedy
                                }}</code>
                                <span v-else class="text-content">{{ sentence(check.remedy) }}</span>
                            </p>
                            <p v-if="whoFixes(check)" class="text-2xs text-subtle">{{ whoFixes(check) }}</p>
                        </div>
                    </li>
                </ul>
                <ul v-if="restOf(report).length > 0" class="flex flex-wrap gap-1.5" :aria-label="t(`local.repair.passedChecks`)">
                    <li
                        v-for="check in restOf(report)"
                        :key="check.id"
                        class="inline-flex items-center gap-1 rounded-full border border-line-subtle px-2 py-0.5 text-2xs"
                        :class="check.state === `skip` ? `text-subtle` : `text-muted`"
                        v-tooltip.top="
                            check.state === `skip`
                                ? { title: t(`local.repair.skipped.title`), note: t(`local.repair.skipped.note`) }
                                : t(`local.repair.passed`)
                        "
                    >
                        <Icon :name="checkLook(check.state).icon" :class="toneInk(checkLook(check.state).tone)" aria-hidden="true" />
                        {{ check.label }}
                    </li>
                </ul>
            </section>
        </div>

        <!-- The engine sandboxes run on, as facts. -->
        <dl v-else-if="reading.kind === `engine`" class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-t border-line-subtle px-4 py-3 text-xs">
            <dt class="text-subtle">{{ t(`local.repair.engine.runsOn`) }}</dt>
            <dd class="text-content">{{ engineName(reading.engine) }}</dd>
            <template v-if="reading.engine.engine === `intentic`">
                <dt class="text-subtle">{{ t(`local.repair.engine.state`) }}</dt>
                <dd class="flex items-center gap-1.5" :class="toneInk(engineTone(reading.engine))">
                    <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
                    {{ engineState(reading.engine) }}
                </dd>
            </template>
            <template v-if="reading.engine.version">
                <dt class="text-subtle">{{ t(`local.repair.engine.version`) }}</dt>
                <dd class="font-mono text-content">{{ reading.engine.version }}</dd>
            </template>
        </dl>

        <!-- A short answer stands as a sentence; a long one is the raw output's. -->
        <p
            v-else-if="reading.kind === `text`"
            class="border-t border-line-subtle px-4 py-3 text-xs"
            :class="tool.state === `failed` ? toneInk(`danger`) : `text-muted`"
        >
            {{ reading.text }}
        </p>

        <div v-if="showRaw && hasRaw" class="relative border-t border-line-subtle bg-canvas">
            <CopyButton :text="tool.detail ?? ``" class="absolute right-2 top-2" />
            <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 pr-10 font-mono text-2xs leading-relaxed text-muted">{{
                tool.detail
            }}</pre>
        </div>
    </article>
</template>
