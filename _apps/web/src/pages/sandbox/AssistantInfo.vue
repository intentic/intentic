<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic-app/ui";

/* The (i) beside the Agent tab's "Assistant" group. These settings share nothing but a heading, so the dialog
 * opens with a what-changes/default table (the only thing that IS common) and then treats each one separately,
 * led by a visual: a real before/after reply for terse, a kept-vs-lost split for the system prompt, an
 * off-vs-on table for iq, a lifecycle strip for archiving. Most are easier to show than to describe, which is
 * why the prose is thin.
 *
 * The system prompt gets the longest section for a reason that isn't its complexity: its three options are
 * NOT three peers. Two are maintained prompts you pick between in a click; the third replaces them, and the
 * cost of that is invisible at the moment of the edit — the chat's cards and panels are driven from the prompt,
 * so a replacement turns them off without an error anywhere. Hence the modes table first, then the kept/lost
 * columns, and only then anything about writing one.
 *
 * Defaults quoted here come from SandboxSettingsSchema — off / intentic / off / 3 days. */

const AT_A_GLANCE = [
    [`Terse responses`, `How much the assistant writes back`, `Off`],
    [`System prompt`, `Who the assistant is, before you say anything`, `Intentic's`],
    [`iq code search`, `How it hunts through your code`, `Off`],
    [`Archive finished agents`, `How long finished work stays on the board`, `3 days`],
];

const TERSE_ASKS = [`Lead with the answer`, `No restating the question`, `No re-quoting files`, `No echoing tool output`];

// The three options, phrased as what each one IS rather than what it is called. The last column is the honest
// one: two of these keep improving without you, and the third is yours to maintain from the day you pick it.
const PROMPT_MODES = [
    [`Intentic`, `Our prompt, tuned for this app. The default.`, `Improves with the app`],
    [`Claude`, `Claude Code's own, read from your sandbox's CLI.`, `Improves with the sandbox`],
    [`Custom`, `Yours, replacing both — and everything below.`, `Frozen the day you write it`],
];

// What a custom prompt actually costs, as a plain inventory. Every row on the "lost" side is a thing the user
// would otherwise discover by noticing it had stopped happening, which is the worst way to learn it.
const PROMPT_LOST = [
    [`The built-in prompt`, `Its whole approach to reading, editing and verifying code`],
    [`The question and plan cards`, `It writes "A) … B) …" as text instead of a card you can click`],
    [`The checklist panel`, `Long tasks run with no visible plan to follow along with`],
    [`The browser tools`, `It stops knowing a real browser is available and reaches for curl`],
    [`Terse responses`, `The toggle stays on screen but no longer does anything`],
];

const PROMPT_KEPT = [
    [`Every tool`, `Nothing is removed — only what the model has been TOLD changes`],
    [`CLAUDE.md and your skills`, `Still loaded from the workspace exactly as before`],
    [`Cross-provider delegation`, `Moves into the first message instead of the prompt`],
];

const IQ_COMPARISON = [
    [`A typical hunt`, `Several calls, then whole files read to find one function`, `One call`],
    [`What comes back`, `Every line that matched the text`, `Ranked answers, trimmed to a token budget`],
    [`Each result`, `A file to open and scan`, `A path:line anchor it can open directly`],
    [`When your words aren't the code's words`, `Misses`, `Still finds it`],
];
</script>

<template>
    <InfoDialog title="Assistant settings">
        <p class="text-sm text-muted">Unrelated settings that happen to share a heading. Each applies to this sandbox only.</p>
        <InfoTable class="mt-2" :headers="[`Setting`, `What it changes`, `Default`]" :rows="AT_A_GLANCE" />

        <!-- ① Terse responses — the same answer written twice is the entire explanation. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Terse responses</h3>
        <p class="mt-1.5 text-2xs text-muted">Adds one standing instruction to the assistant:</p>
        <div class="mt-2 flex flex-wrap gap-1.5">
            <span v-for="ask in TERSE_ASKS" :key="ask" class="rounded-md border border-line bg-canvas px-2 py-0.5 text-2xs text-muted">{{
                ask
            }}</span>
        </div>
        <div class="mt-2 grid gap-2 sm:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">Off</p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    "Great question! Let me take a look at that authentication file. Here's the current content of
                    <span class="font-mono">auth.ts</span> for reference: … Looking at this, I can see that on line 42 the token check runs before the
                    session is loaded, which means…"
                </p>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">On</p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    "<span class="font-mono">auth.ts:42</span> — the token check runs before the session loads. That's the bug."
                </p>
            </div>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">
            Same tools, same work, same thoroughness — less narration. It's appended at a fixed spot at the very end of the standing instructions, so
            it doesn't disturb the reuse that keeps a long conversation's later turns cheap.
        </p>
        <!-- Why this one setting has a measurement control and the others don't: it is the only one whose effect
             cannot be observed on the turn it applies to. Said plainly, because "Measure it" next to a switch
             otherwise reads as telemetry rather than the experiment it is. -->
        <div class="mt-2 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="wave-pulse" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">Measure it</span> runs a slice of turns without the instruction, as a control. There's no other
                way to know what it's worth — the same turn can't be replayed to see what it would have said otherwise. Both groups need about 30
                turns before a figure appears, because one turn is "yes" and the next is a forty-tool refactor. The result lands under
                <span class="font-medium text-content">Usage → Assistant's own output</span>.
            </p>
        </div>

        <!-- ② System prompt — leads with the three options as a table, because "Intentic / Claude / Custom"
             on a segmented control tells you nothing about which to press. Then what Custom costs, which is the
             only one of the three that is a decision rather than a preference. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">System prompt</h3>
        <p class="mt-1.5 text-2xs text-muted">
            The instructions the assistant carries before you type anything — who it is, how it works, what it may assume. Three to choose from, and
            you can read any of them in full before you pick: <span class="font-medium text-content">View this prompt</span> on the setting.
        </p>
        <InfoTable class="mt-2" :headers="[`Option`, `What it is`, `Over time`]" :rows="PROMPT_MODES" />
        <p class="mt-2 text-2xs text-muted">
            Intentic and Claude are peers — a different prompt, everything else identical, one click apart. Writing your own is the different one: it
            <span class="font-medium text-content">replaces</span> them. Not adds to them — replaces them. That is real power (an agent that is a
            release-notes writer, a support bot, a reviewer with your house rules) and it has a real cost, because this app talks to the assistant
            through that same prompt.
        </p>
        <div class="mt-2 grid gap-2 sm:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-warning/40">
                <p class="border-b border-warning/40 bg-warning/10 px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-warning">
                    What Custom gives up
                </p>
                <div class="flex flex-col gap-1.5 px-2.5 py-2">
                    <p v-for="[what, effect] in PROMPT_LOST" :key="what" class="text-2xs text-muted">
                        <span class="font-medium text-content">{{ what }}</span> — {{ effect }}
                    </p>
                </div>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">What stays</p>
                <div class="flex flex-col gap-1.5 px-2.5 py-2">
                    <p v-for="[what, effect] in PROMPT_KEPT" :key="what" class="text-2xs text-muted">
                        <span class="font-medium text-content">{{ what }}</span> — {{ effect }}
                    </p>
                </div>
            </div>
        </div>
        <p class="mt-2 text-2xs text-subtle">
            <span class="font-medium text-content">Edit a copy of it</span> is the gentler route into Custom: fork whichever prompt you are on and
            change the parts you care about, keeping the rest. The trade is that a fork is a snapshot — it stops picking up improvements, which is why
            the dialog shows the version it came from. Switching back to Intentic or Claude is one click and loses nothing: your text stays in the box
            for the next time you pick Custom.
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            It applies to every model running on the Claude Code harness — including ChatGPT and Grok when you run them there — and to every chat in
            this sandbox, automated wake-ups and web-chat visitors included. A chat on a provider's own runtime uses that provider's prompt instead.
            Ordinary preferences ("answer in Polish") do not need this: put them in CLAUDE.md, which is read alongside whichever prompt is in force.
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            Editing it costs one turn's worth of the reuse that keeps long conversations cheap, then settles back. Write it and leave it — it isn't a
            place to steer a single task from.
        </p>

        <!-- ③ iq — an off/on comparison, because the value is entirely relative to grep. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">iq code search</h3>
        <p class="mt-1.5 text-2xs text-muted">
            iq is a search tool built into the sandbox. Where grep answers "which lines contain this text", iq answers "where does this happen" — it
            works out what you're asking, runs several kinds of search at once, then ranks and trims the result.
        </p>
        <InfoTable class="mt-2" :headers="[``, `Off — grep / find / glob`, `On — iq`]" :rows="IQ_COMPARISON" />
        <p class="mt-1.5 text-2xs text-subtle">
            Switching it on loads a small plugin that teaches the assistant iq's commands and nudges it to reach for them. The Search box in your
            workspace uses iq either way — this only changes what the assistant does.
        </p>

        <!-- ④ Archiving — a lifecycle, so a lifecycle strip, then the kept/released split it turns on. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Archive finished agents</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Every agent works in its own checkout of your repository, so two can never trip over each other's edits. That checkout is real disk, and
            it stays put after the agent stops — as does its card on the board.
        </p>
        <div class="mt-2 flex items-stretch gap-1.5">
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="check-circle" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">Agent finishes</span>
            </div>
            <Icon name="arrow-right" class="shrink-0 self-center text-2xs text-subtle" />
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="clock" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">Quiet for your chosen time</span>
            </div>
            <Icon name="arrow-right" class="shrink-0 self-center text-2xs text-subtle" />
            <div class="flex flex-1 flex-col items-center rounded-lg border border-line bg-canvas px-2 py-2.5 text-center">
                <Icon name="box" class="text-muted" />
                <span class="mt-1 text-2xs font-medium text-content">Archived</span>
            </div>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2">
            <div class="rounded-lg border border-line bg-canvas p-2.5">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-content"><Icon name="eraser" class="text-subtle" /> Released</p>
                <p class="mt-1 text-2xs text-muted">Its checkout of your repo, and its spot on the board.</p>
            </div>
            <div class="rounded-lg border border-line bg-canvas p-2.5">
                <p class="flex items-center gap-1.5 text-xs font-semibold text-content"><Icon name="history" class="text-subtle" /> Kept</p>
                <p class="mt-1 text-2xs text-muted">Its branch, its diff, and the whole conversation — restorable any time.</p>
            </div>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">
            Talking to an agent resets its clock, so one you're still using never ages out from under you. The sweep runs when the sandbox starts and
            once an hour after. "Never" keeps every card — and one checkout per agent — indefinitely.
        </p>
    </InfoDialog>
</template>
