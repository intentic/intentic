<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// Info dialog for the Agent tab's Command output group: what the shell-output filter does, ordered as visuals
// first (path, success/failure split, a real command) then the cleaner table.
// Keep in sync with bin/cleaners.mjs: the pnpm sample and cap/dedupe numbers below are quoted verbatim.

// One real `pnpm install` sample; CLEANED_OUTPUT is derived from it so the two panes can't drift apart.
const t = useT();

const PNPM_OUTPUT = [
    { text: `Progress: resolved 12, reused 12, downloaded 0`, dropped: true },
    { text: `Packages: +148`, dropped: true },
    { text: `++++++++++++++++++++++++++++++`, dropped: true },
    { text: `Downloading @esbuild/linux-x64: 9.2 MB/9.2 MB, done`, dropped: true },
    { text: `Progress: resolved 903, reused 900, downloaded 3`, dropped: true },
    { text: `Virtual store is at: node_modules/.pnpm`, dropped: true },
    { text: `Lockfile is up to date, resolution step is skipped`, dropped: true },
    { text: `Done in 4.2s`, dropped: false },
];
const CLEANED_OUTPUT = PNPM_OUTPUT.filter((line) => !line.dropped).map((line) => line.text);

const PER_TOOL_CLEANERS = [
    [`pnpm`, `Progress bars, download lines, package counters`],
    [`apt`, `Fetching, unpacking and "setting up" lines`],
    [`test runners`, `On a green run, the line-per-passing-test list, but the summary stays`],
    [`directory listings`, `Every long-listing entry loses its link count, owner, group and timestamp, keeping mode, name and size`],
    [`file lists`, `A run of paths (from find, git ls-files, rg -l) groups under its directory, saying the shared root once`],
    [`search hits`, `A file's name is said once and its later hits indent under it, every line number and match kept`],
    [`generated-file diffs`, `A diff hunk in a lock file, bundle or source map becomes one line saying how much changed`],
];
const GLOBAL_CLEANERS = [
    [`dedupe repeats`, `3 or more identical lines in a row become one, plus a count`],
    [`machine-generated blobs`, `A run of 400 characters with no space in it — minified JSON, base64, a bundled file — keeps its start and end`],
    [`head/tail cap`, `Over 100 lines keeps the first 30 and the last 50, though a file read (cat, sed -n, git diff) keeps 2000`],
    [`redact secrets`, `Masks credential-shaped values after a token/password/key name, and credentials in URLs`],
    [`collapse repeats`, `Output identical to an earlier run this session isn't shown twice`],
];
</script>

<template>
    <InfoDialog :title="t(`sandbox.commandOutputInfo.cleaningCommandOutput`)">
        <p class="text-sm text-muted">
            {{ t(`sandbox.commandOutputInfo.agentRunsShellCommands`) }}
        </p>

        <!-- The output's path: three boxes, since the log vs. assistant branch is the trust story. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.commandOutputInfo.whereOutputGoes`) }}</h3>
        <div class="mt-2 flex items-stretch gap-1.5">
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="code" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">{{ t(`sandbox.commandOutputInfo.commandRuns`) }}</span>
            </div>
            <Icon name="arrow-right" class="shrink-0 self-center text-2xs text-subtle" />
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="bolt" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">{{ t(`sandbox.commandOutputInfo.cleaner`) }}</span>
            </div>
            <Icon name="arrow-right" class="shrink-0 self-center text-2xs text-subtle" />
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="sparkles" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">{{ t(`sandbox.commandOutputInfo.assistant`) }}</span>
            </div>
        </div>
        <div class="mt-1.5 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="database" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">{{ t(`sandbox.commandOutputInfo.fullOutputAlwaysGoes`) }}</span
                >{{ t(`sandbox.commandOutputInfo.untouchedWhateverCleanerDid`) }}
            </p>
        </div>

        <!-- Status colours always pair with an icon and label, never colour alone. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">
            {{ t(`sandbox.commandOutputInfo.successFailureTreatedDifferently`) }}
        </h3>
        <div class="mt-2 grid grid-cols-2 gap-2">
            <div class="rounded-lg border border-success/30 bg-success/10 p-2.5">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-success">
                    <Icon name="check-circle" /> {{ t(`sandbox.commandOutputInfo.succeeded`) }}
                </p>
                <p class="mt-1 text-2xs text-muted">{{ t(`sandbox.commandOutputInfo.toolNoiseTrimmedAnything`) }}</p>
            </div>
            <div class="rounded-lg border border-warning/30 bg-warning/10 p-2.5">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-warning">
                    <Icon name="exclamation-triangle" /> {{ t(`sandbox.commandOutputInfo.failed`) }}
                </p>
                <p class="mt-1 text-2xs text-muted">{{ t(`sandbox.commandOutputInfo.nothingTrimmedErrorsStack`) }}</p>
            </div>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">{{ t(`sandbox.commandOutputInfo.colourCodesProgressBar`) }}</p>

        <!-- One real command: struck lines vs. what survives. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.commandOutputInfo.onRealCommand`) }}</h3>
        <div class="mt-2 grid gap-2 @lg:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.commandOutputInfo.whatPnpmPrinted`) }}
                </p>
                <!-- Truncate, not wrap: a wrapped line would look like two, and the pane's rows must stay countable. -->
                <div class="flex flex-col gap-1 px-2.5 py-2 font-mono text-[0.65rem] leading-tight">
                    <span
                        v-for="line in PNPM_OUTPUT"
                        :key="line.text"
                        class="truncate"
                        :class="line.dropped ? `text-subtle line-through` : `text-content`"
                    >
                        {{ line.text }}
                    </span>
                </div>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                    {{ t(`sandbox.commandOutputInfo.whatAssistantRead`) }}
                </p>
                <div class="flex flex-col gap-1 px-2.5 py-2 font-mono text-[0.65rem] leading-tight">
                    <span v-for="line in CLEANED_OUTPUT" :key="line" class="truncate text-content">{{ line }}</span>
                    <!-- Wraps rather than truncates: the retrieval handle it names is what makes the trim reversible. -->
                    <span class="mt-1 text-subtle">{{ t(`sandbox.commandOutputInfo.exit042s`) }}</span>
                </div>
            </div>
        </div>

        <!-- A lookup table (twelve rules), not a bullet list. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.commandOutputInfo.whatEachCleanerTakes`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.commandOutputInfo.ruleOnlyEverTouches`) }}
        </p>
        <InfoTable class="mt-2" :headers="[`Per tool`, `Removes`]" :rows="PER_TOOL_CLEANERS" />
        <InfoTable class="mt-4" :headers="[`Every command`, `Removes`]" :rows="GLOBAL_CLEANERS" />
        <p class="mt-1.5 text-2xs text-subtle">{{ t(`sandbox.commandOutputInfo.dedupeRedactionRunOn`) }}</p>

        <!-- Per-mechanism figures and the holdout measure different things: one is bookkeeping within a command, the other compares two populations of commands. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">{{ t(`sandbox.commandOutputInfo.whatSavingsNumbersMean`) }}</h3>
        <p class="mt-1.5 text-2xs text-muted">
            {{ t(`sandbox.commandOutputInfo.everyCommandWeighedBefore`) }}
            <span class="font-medium text-content">{{ t(`sandbox.commandOutputInfo.rulesRunOneAfter`) }}</span
            >{{ t(`sandbox.commandOutputInfo.ruleNearFrontCredited`) }}
        </p>
        <div class="mt-2 flex items-center gap-3 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <div class="flex shrink-0 gap-1" role="img" :aria-label="t(`sandbox.commandOutputInfo.oneCommandInTen`)">
                <span v-for="slot in 10" :key="slot" class="h-4 w-2 rounded-sm" :class="slot === 1 ? `bg-content` : `bg-content/15`" />
            </div>
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">{{ t(`sandbox.commandOutputInfo.holdoutAt10`) }}</span>
                {{ t(`sandbox.commandOutputInfo.about1CommandIn`) }}
            </p>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">
            {{ t(`sandbox.commandOutputInfo.fullBreakdownEveryMechanism`) }}
        </p>

        <div class="mt-5 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="shield" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">{{ t(`sandbox.commandOutputInfo.failsOpen`) }}</span>
                {{ t(`sandbox.commandOutputInfo.cleaningErrorsAnyReason`) }}
            </p>
        </div>
    </InfoDialog>
</template>
