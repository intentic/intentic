<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";
import { promptReach, spokenList } from "./promptReach";

const PROMPT_MODES = [
    [`Intentic`, `Our prompt, tuned for this app. The default.`, `Improves with the app`],
    [`Claude`, `Claude Code's own, read from your sandbox's CLI.`, `Improves with the sandbox`],
    [`Custom`, `Yours, replacing both, and everything below.`, `Frozen the day you write it`],
];

const PROMPT_LOST = [
    [`The built-in prompt`, `Its whole approach to reading, editing and verifying code`],
    [`The question and plan cards`, `It writes "A) … B) …" as text instead of a card you can click`],
    [`The checklist panel`, `Long tasks run with no visible plan to follow along with`],
    [`The browser tools`, `It stops knowing a real browser is available and reaches for curl`],
    [`Knowing how to wait`, `It polls a build with sleep instead of backgrounding it and being woken`],
];

const PROMPT_KEPT = [
    [`Every tool`, `Nothing is removed, only what the model has been TOLD changes`],
    [`CLAUDE.md and your skills`, `Still loaded from the workspace exactly as before`],
    [`The in-turn notices`, `Hooks are a separate layer: the search, dependency and diagnostics steers still fire`],
    [`Cross-provider delegation`, `Moves into the first message instead of the prompt`],
];

const reach = promptReach();
const REACH_ROWS = [
    [spokenList(reach.replaces), `Your prompt replaces theirs`],
    ...(reach.adds.length > 0 ? [[spokenList(reach.adds), `Keeps its own prompt; yours is added to it`]] : []),
];
</script>

<template>
    <InfoDialog title="Instructions">
        <p class="text-sm text-muted">What the assistant is told before you say anything. This sandbox only.</p>

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
