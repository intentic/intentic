<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { promptReach, spokenList } from "./promptReach";

/* The (i) beside the Agent tab's "Instructions" group: what the assistant is told before you type anything.
 * Two settings, and they are not peers in weight: terse is a preference, the system prompt is a decision.
 *
 * The system prompt gets the longer section for a reason that isn't its complexity: its three options are NOT
 * three peers either. Two are maintained prompts you pick between in a click; the third replaces them, and the
 * cost of that is invisible at the moment of the edit: the chat's cards and panels are driven from the prompt,
 * so a replacement turns them off without an error anywhere. Hence the modes table first, then the kept/lost
 * columns, and only then anything about writing one.
 *
 * Defaults quoted here come from SandboxSettingsSchema: off / intentic. */

const TERSE_ASKS = [`Lead with the answer`, `No restating the question`, `No re-quoting files`, `No echoing tool output`];

// The three options, phrased as what each one IS rather than what it is called. The last column is the honest
// one: two of these keep improving without you, and the third is yours to maintain from the day you pick it.
const PROMPT_MODES = [
    [`Intentic`, `Our prompt, tuned for this app. The default.`, `Improves with the app`],
    [`Claude`, `Claude Code's own, read from your sandbox's CLI.`, `Improves with the sandbox`],
    [`Custom`, `Yours, replacing both, and everything below.`, `Frozen the day you write it`],
];

// What a custom prompt actually costs, as a plain inventory. Every row on the "lost" side is a thing the user
// would otherwise discover by noticing it had stopped happening, which is the worst way to learn it.
//
// Only what the PROMPT carries belongs here. The hooks are a separate layer and survive a custom prompt intact,
// so the search steer is deliberately absent: the agent is still told about `rg` the first time it walks the
// repo with grep, it just learns it a search later than it would have (agent/agent-search.ts). Listing it as
// lost would overstate the cost, which is the same disservice as understating it.
const PROMPT_LOST = [
    [`The built-in prompt`, `Its whole approach to reading, editing and verifying code`],
    [`The question and plan cards`, `It writes "A) … B) …" as text instead of a card you can click`],
    [`The checklist panel`, `Long tasks run with no visible plan to follow along with`],
    [`The browser tools`, `It stops knowing a real browser is available and reaches for curl`],
    [`Knowing how to wait`, `It polls a build with sleep instead of backgrounding it and being woken`],
    [`Terse responses`, `The toggle stays on screen but no longer does anything`],
];

const PROMPT_KEPT = [
    [`Every tool`, `Nothing is removed, only what the model has been TOLD changes`],
    [`CLAUDE.md and your skills`, `Still loaded from the workspace exactly as before`],
    [`The in-turn notices`, `Hooks are a separate layer: the search, dependency and diagnostics steers still fire`],
    [`Cross-provider delegation`, `Moves into the first message instead of the prompt`],
];

// Grouped from the runtime records rather than listed by hand, so a provider added later cannot go unmentioned
//, which is precisely how this setting spent its life looking like it applied to everything.
const reach = promptReach();
const REACH_ROWS = [
    [spokenList(reach.replaces), `Your prompt replaces theirs`],
    ...(reach.adds.length > 0 ? [[spokenList(reach.adds), `Keeps its own prompt; yours is added to it`]] : []),
];
</script>

<template>
    <InfoDialog title="Instructions">
        <p class="text-sm text-muted">What the assistant is told before you say anything, and how much it writes back. This sandbox only.</p>

        <!-- ① Terse responses: the same answer written twice is the entire explanation. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Terse responses</h3>
        <p class="mt-1.5 text-2xs text-muted">Adds one standing instruction to the assistant:</p>
        <div class="mt-2 flex flex-wrap gap-1.5">
            <span v-for="ask in TERSE_ASKS" :key="ask" class="rounded-md border border-line bg-canvas px-2 py-0.5 text-2xs text-muted">{{
                ask
            }}</span>
        </div>
        <div class="mt-2 grid gap-2 @lg:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">Off</p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    "Great question! Let me take a look at that authentication file. Here's the current content of
                    <span class="font-mono">auth.ts</span> for reference: … Looking at this, I can see that on line 42 the token check runs before the
                    session is loaded, which means…"
                </p>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">On</p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    "<span class="font-mono">auth.ts:42</span>, the token check runs before the session loads. That's the bug."
                </p>
            </div>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">
            Same tools, same work, same thoroughness, just less narration. It's appended at a fixed spot at the very end of the standing instructions, so
            it doesn't disturb the reuse that keeps a long conversation's later turns cheap.
        </p>
        <!-- Why this setting carries a measurement control and most don't: its effect cannot be observed on the
             turn it applies to, so it needs a control group. Said plainly, because "Measure it" next to a switch
             otherwise reads as telemetry rather than the experiment it is. -->
        <div class="mt-2 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="wave-pulse" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">Measure it</span> runs a slice of turns without the instruction, as a control. There's no other
                way to know what it's worth: the same turn can't be replayed to see what it would have said otherwise. Both groups need about 30
                turns before a figure appears, because one turn is "yes" and the next is a forty-tool refactor. The result lands under
                <span class="font-medium text-content">Usage → Assistant's own output</span>.
            </p>
        </div>

        <!-- ② System prompt: leads with the three options as a table, because "Intentic / Claude / Custom"
             on a segmented control tells you nothing about which to press. Then what Custom costs, which is the
             only one of the three that is a decision rather than a preference. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">System prompt</h3>
        <p class="mt-1.5 text-2xs text-muted">
            The instructions the assistant carries before you type anything, who it is, how it works, what it may assume. Three to choose from, and
            you can read any of them in full before you pick: <span class="font-medium text-content">View this prompt</span> on the setting.
        </p>
        <InfoTable class="mt-2" :headers="[`Option`, `What it is`, `Over time`]" :rows="PROMPT_MODES" />
        <p class="mt-2 text-2xs text-muted">
            Intentic and Claude are peers: a different prompt, everything else identical, one click apart. Writing your own is the different one: it
            <span class="font-medium text-content">replaces</span> them. Not adds to them: replaces them. That is real power (an agent that is a
            release-notes writer, a support bot, a reviewer with your house rules) and it has a real cost, because this app talks to the assistant
            through that same prompt. If you want that power for one job rather than for the whole sandbox, a persona can carry its own prompt, and
            its own skills: without changing anything else here.
        </p>
        <div class="mt-2 grid gap-2 @lg:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-warning/40">
                <p class="border-b border-warning/40 bg-warning/10 px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-warning">
                    What Custom gives up
                </p>
                <div class="flex flex-col gap-1.5 px-2.5 py-2">
                    <p v-for="[what, effect] in PROMPT_LOST" :key="what" class="text-2xs text-muted">
                        <span class="font-medium text-content">{{ what }}</span>: {{ effect }}
                    </p>
                </div>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line-subtle bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">What stays</p>
                <div class="flex flex-col gap-1.5 px-2.5 py-2">
                    <p v-for="[what, effect] in PROMPT_KEPT" :key="what" class="text-2xs text-muted">
                        <span class="font-medium text-content">{{ what }}</span>: {{ effect }}
                    </p>
                </div>
            </div>
        </div>
        <p class="mt-2 text-2xs text-subtle">
            <span class="font-medium text-content">Edit a copy of it</span> is the gentler route into Custom: fork whichever prompt you are on and
            change the parts you care about, keeping the rest. The trade is that a fork is a snapshot: it stops picking up improvements, which is why
            the dialog shows the version it came from. Switching back to Intentic or Claude is one click and loses nothing: your text stays in the box
            for the next time you pick Custom.
        </p>
        <!-- ③ Who it reaches. This used to be one buried sentence saying "the Claude Code harness". True, and
             the reason a Grok or Codex chat quietly ran without the prompt somebody had written. The table is
             derived from the same record the daemon composes against, so it cannot go stale when a provider is
             added or a runtime grows a seam it did not have. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Where it applies</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Every chat in this sandbox, automated wake-ups and web-chat visitors included, but what each model does with it depends on what that
            model lets us set.
        </p>
        <InfoTable class="mt-2" :headers="[`Model`, `What happens`]" :rows="REACH_ROWS" />
        <p class="mt-1.5 text-2xs text-subtle">
            An agent you install yourself brings its own prompt and offers no way to set one, so it keeps it, and the model picker says so on the chat it
            would affect. Ordinary preferences ("answer in Polish") do not need this: put them in CLAUDE.md, which is read alongside whichever prompt
            is in force. A single persona can run on a prompt of its own: see Personas.
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            Editing it costs one turn's worth of the reuse that keeps long conversations cheap, then settles back. Write it and leave it. It isn't a
            place to steer a single task from.
        </p>
    </InfoDialog>
</template>
