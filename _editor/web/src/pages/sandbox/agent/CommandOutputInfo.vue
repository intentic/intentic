<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";

/* The (i) beside the Agent tab's "Command output" group: what the shell-output filter does, for an owner
 * deciding whether to turn it on and how far to trust it.
 *
 * Built as visuals first, prose second: the toggle's real question is "if you delete output before the AI
 * sees it, what am I losing?", and a worked before/after answers that in one glance where three paragraphs
 * don't. Hence the order: path the output takes, the success/failure split, a real command, and only then
 * the cleaner inventory (a 13-row lookup, so a table, not a bullet list).
 *
 * Keep in sync with bin/cleaners.mjs: the sample below is the actual pnpm strip set, and the cap/dedupe
 * numbers (100 → 30 + 50, 3+ repeats, 500-line failure tail) are quoted verbatim. */

// One real `pnpm install`: the raw pane, with the lines the pnpm cleaner drops marked. The cleaned pane is
// derived from it rather than written out, so the two can never drift apart in a way that overstates the win.
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
];
const GLOBAL_CLEANERS = [
    [`dedupe repeats`, `3 or more identical lines in a row become one, plus a count`],
    [`head/tail cap`, `Over 100 lines keeps the first 30 and the last 50, though a file read (cat, sed -n, git diff) keeps 2000`],
    [`redact secrets`, `Masks credential-shaped values after a token/password/key name, and credentials in URLs`],
    [`collapse repeats`, `Output identical to an earlier run this session isn't shown twice`],
];
</script>

<template>
    <InfoDialog title="Cleaning command output">
        <p class="text-sm text-muted">
            Your agent runs shell commands all day: installs, builds, tests, git. Most of what they print is scaffolding. Cleaning strips the
            scaffolding out before the assistant reads it, so the tokens go on your code instead.
        </p>

        <!-- ① The path output takes. Three boxes, because the branch (log vs assistant) is the whole trust story. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Where the output goes</h3>
        <div class="mt-2 flex items-stretch gap-1.5">
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="code" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">Command runs</span>
            </div>
            <Icon name="arrow-right" class="shrink-0 self-center text-2xs text-subtle" />
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="bolt" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">Cleaner</span>
            </div>
            <Icon name="arrow-right" class="shrink-0 self-center text-2xs text-subtle" />
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="sparkles" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">Assistant</span>
            </div>
        </div>
        <div class="mt-1.5 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="database" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">The full output always goes to the terminal log</span>, untouched, whatever the cleaner did.
                When lines are left out, the assistant is handed the command to fetch them back.
            </p>
        </div>

        <!-- ② The success/failure split: status colours, each with an icon and a label, never colour alone. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Success and failure are treated differently</h3>
        <div class="mt-2 grid grid-cols-2 gap-2">
            <div class="rounded-lg border border-success/30 bg-success/10 p-2.5">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-success"><Icon name="check-circle" /> Succeeded</p>
                <p class="mt-1 text-2xs text-muted">Tool noise trimmed. Anything over 100 lines keeps its first 30 and last 50.</p>
            </div>
            <div class="rounded-lg border border-warning/30 bg-warning/10 p-2.5">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-warning"><Icon name="exclamation-triangle" /> Failed</p>
                <p class="mt-1 text-2xs text-muted">Nothing trimmed. Errors and stack traces arrive word for word, up to 500 lines.</p>
            </div>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">Colour codes and progress-bar redraw frames go either way. They were never information.</p>

        <!-- ③ The hero visual: one real command, struck lines vs what survives. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">On a real command</h3>
        <div class="mt-2 grid gap-2 @lg:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">What pnpm printed</p>
                <!-- truncate, not wrap: a wrapped line looks like two, and the whole point of the pane is that
                     you can count the rows on each side. -->
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
                <p class="border-b border-line bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">
                    What the assistant read
                </p>
                <div class="flex flex-col gap-1 px-2.5 py-2 font-mono text-[0.65rem] leading-tight">
                    <span v-for="line in CLEANED_OUTPUT" :key="line" class="truncate text-content">{{ line }}</span>
                    <!-- The filter's own footer: it wraps rather than truncating, because the retrieval handle
                         it names is the thing that makes the trimming reversible. -->
                    <span class="mt-1 text-subtle">--- [exit 0, 4.2s] 8 lines filtered to 1 · full: retrieve-output …</span>
                </div>
            </div>
        </div>

        <!-- ④ 13 rules that all carry meaning: a lookup, so a table rather than thirteen bullets. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">What each cleaner takes out</h3>
        <p class="mt-1.5 text-2xs text-muted">
            A rule only ever touches the tool it's named for, so the git rule can't reach your test output. Switch any of them off on its own.
        </p>
        <InfoTable class="mt-2" :headers="[`Per tool`, `Removes`]" :rows="PER_TOOL_CLEANERS" />
        <InfoTable class="mt-4" :headers="[`Every command`, `Removes`]" :rows="GLOBAL_CLEANERS" />
        <p class="mt-1.5 text-2xs text-subtle">Dedupe and redaction run on failures too: neither can cost you a detail.</p>

        <!-- ⑤ What the numbers mean. The per-mechanism figure and the holdout answer DIFFERENT questions, and
             a reader who thinks they are the same number will misread both: one is bookkeeping within a
             command, the other is a comparison between two populations of commands. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">What the savings numbers mean</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Every command is weighed before and after each rule runs, so the figure beside a switch is what that rule actually removed, counted rather than
            estimated. Read it in pipeline order, though:
            <span class="font-medium text-content">the rules run one after another</span>, so a rule near the front is credited with lines the
            head/tail cap behind it would have taken anyway. Turning it off usually costs less than its number suggests.
        </p>
        <div class="mt-2 flex items-center gap-3 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <div class="flex shrink-0 gap-1" role="img" aria-label="One command in ten left raw">
                <span v-for="slot in 10" :key="slot" class="h-4 w-2 rounded-sm" :class="slot === 1 ? `bg-content` : `bg-content/15`" />
            </div>
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">Holdout, at 10%:</span> about 1 command in 10 skips cleaning and is recorded raw. That is the
                only figure that covers the pipeline as a whole: a real cleaned-vs-raw comparison rather than an accounting of who removed what.
            </p>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">
            The full breakdown (every mechanism, and what was left for the assistant) is on the Usage tab, where you can pick a date range.
        </p>

        <div class="mt-5 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="shield" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">Fails open.</span> If cleaning errors for any reason, the assistant gets the raw output,
                exactly as though the feature were off. A bug in here can cost you tokens. It can't lose output or break a command.
            </p>
        </div>
    </InfoDialog>
</template>
