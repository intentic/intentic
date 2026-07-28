<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic-app/ui";

/* The (i) beside the Agent tab's "Assistant" group. These settings share nothing but a heading, so the dialog
 * opens with a what-changes/default table (the only thing that IS common) and then treats each one separately,
 * led by a visual: a real before/after reply for terse, a where-does-it-go table for custom instructions, an
 * off-vs-on table for iq, a lifecycle strip for archiving. Most are easier to show than to describe, which is
 * why the prose is thin.
 *
 * Custom instructions gets the longest section for a reason that isn't its complexity: the sandbox has TWO
 * places to write standing orders (this and CLAUDE.md) and the wrong choice is silent — instructions in the
 * wrong file still work, they just leak to teammates or fail to reach ChatGPT. So the section leads with the
 * split rather than with the feature.
 *
 * Defaults quoted here come from SandboxSettingsSchema — off / empty / off / 3 days. */

const AT_A_GLANCE = [
    [`Terse responses`, `How much the assistant writes back`, `Off`],
    [`Custom instructions`, `Standing orders it carries into every turn`, `Empty`],
    [`iq code search`, `How it hunts through your code`, `Off`],
    [`Archive finished agents`, `How long finished work stays on the board`, `3 days`],
];

const TERSE_ASKS = [`Lead with the answer`, `No restating the question`, `No re-quoting files`, `No echoing tool output`];

// The choice the section exists to make. Rows are phrased as the QUESTION a user actually has, not as a
// feature comparison — nobody wonders "which one is version-controlled", they wonder "where do I put this".
const INSTRUCTIONS_VS_MEMORY = [
    [`What it's for`, `How the agent works with you`, `What the code is and how to build it`],
    [`Who else gets it`, `Nobody — it stays in this sandbox`, `Your teammates, via the repo`],
    [`Which assistants read it`, `Claude, and any model on the Claude Code harness`, `Claude here, ChatGPT via AGENTS.md`],
    [`Where it lands`, `The system prompt — the strongest position there is`, `A file the agent reads in`],
];

const INSTRUCTIONS_EXAMPLES = [`Answer in Polish`, `Never run migrations without asking`, `Call me by my first name`, `Prefer pnpm over npm`];

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

        <!-- ② Custom instructions — the same mechanism as terse, with the text left to you. Leads with the
             CLAUDE.md split because that's the decision, not the typing. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Custom instructions</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Terse responses is one instruction we wrote for you. This is the same slot, left blank — whatever you put in it is carried into every turn
            in this sandbox, at the very end of the assistant's standing instructions.
        </p>
        <div class="mt-2 flex flex-wrap gap-1.5">
            <span
                v-for="example in INSTRUCTIONS_EXAMPLES"
                :key="example"
                class="rounded-md border border-line bg-canvas px-2 py-0.5 text-2xs text-muted"
                >{{ example }}</span
            >
        </div>
        <p class="mt-3 text-2xs font-medium text-content">This or CLAUDE.md?</p>
        <InfoTable class="mt-1.5" :headers="[``, `Custom instructions`, `CLAUDE.md`]" :rows="INSTRUCTIONS_VS_MEMORY" />
        <p class="mt-1.5 text-2xs text-subtle">
            Two things worth knowing. It reaches every model running on the Claude Code harness — including ChatGPT and Grok when you run them there —
            but a chat on a provider's own runtime doesn't see it. And a chat opened by someone outside your sandbox (a web-chat visitor, a Discord
            mention) is deliberately left out: those replies are steered by the automation that opened them, not by how you like being spoken to.
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
