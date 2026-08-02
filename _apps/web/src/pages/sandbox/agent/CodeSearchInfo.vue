<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic-app/ui";

/* The (i) beside the Agent tab's "Code search" group. Two settings that compose and are easy to confuse — one
 * teaches the assistant to search, the other searches before it decides to — so both are explained as an
 * off-vs-on comparison and the second is framed by WHEN the searching happens, which is the whole difference.
 *
 * Defaults quoted here come from SandboxSettingsSchema — off / off. */

const IQ_COMPARISON = [
    [`A typical hunt`, `Several calls, then whole files read to find one function`, `One call`],
    [`What comes back`, `Every line that matched the text`, `Ranked answers, trimmed to a token budget`],
    [`Each result`, `A file to open and scan`, `A path:line anchor it can open directly`],
    [`When your words aren't the code's words`, `Misses`, `Still finds it`],
];

const PREFETCH_COMPARISON = [
    [`How a message starts`, `A search or three, then the work`, `The answer is already in front of it`],
    [`Who pays for the search`, `The assistant, a round trip at a time`, `The sandbox, once, before the turn`],
    [`When your message names a file`, `Opens it`, `Nothing is retrieved — you already said where`],
];
</script>

<template>
    <InfoDialog title="Code search">
        <p class="text-sm text-muted">How the assistant finds its way around your code. Both apply to this sandbox only.</p>

        <!-- ① iq — an off/on comparison, because the value is entirely relative to grep. -->
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

        <!-- ② Retrieve before the turn — the sibling of ①, and the one thing worth being precise about is that
             the assistant is not being told what to think: it is handed a search result and can ignore it. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Retrieve before the turn</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Every message you send is a question about your code before it is anything else. With this on, the sandbox searches for it the moment you
            press send and hands the assistant the ranked answer along with your words — so the reply starts from
            <span class="font-mono">path:line</span> anchors instead of spending its first few moves finding them.
        </p>
        <InfoTable class="mt-2" :headers="[``, `Off — it searches when it decides to`, `On — searched already`]" :rows="PREFETCH_COMPARISON" />
        <p class="mt-1.5 text-2xs text-subtle">
            It's a head start, not an instruction: the assistant is told the search may have missed, and its own search tools are untouched. Messages
            with nothing to look up — "yes, do that", "thanks" — are left alone, and so are ones that already name a file. Independent of
            <span class="font-medium text-content">iq code search</span> above, and they work well together: that one teaches it to search, this one
            answers before it asks.
        </p>
        <div class="mt-2 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="wave-pulse" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">Measure it</span> runs a slice of messages without the head start, as a control — the same
                arrangement the terse steer uses, and for the same reason. The figure here is
                <span class="font-medium text-content">cost per turn</span>, not tokens: the context it hands over costs input tokens on purpose, to
                buy back the searches that would have followed. It lands under
                <span class="font-medium text-content">Usage → Search before the turn</span>.
            </p>
        </div>
    </InfoDialog>
</template>
