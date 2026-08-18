<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";

/* The (i) beside the Agent tab's "Code search" group. Two settings that compose and are easy to confuse — one
 * teaches the assistant to search, one answers the question that comes before any search — so each is explained
 * as an off-vs-on comparison and framed by WHEN it happens, which is the whole difference between them.
 *
 * Defaults quoted here come from SandboxSettingsSchema — off / off. */

const IQ_COMPARISON = [
    [`A typical hunt`, `Several calls, then whole files read to find one function`, `One call`],
    [`What comes back`, `Every line that matched the text`, `Ranked answers, trimmed to a token budget`],
    [`Each result`, `A file to open and scan`, `A path:line anchor it can open directly`],
    [`When your words aren't the code's words`, `Misses`, `Still finds it`],
];

const MAP_COMPARISON = [
    [`How a conversation starts`, `Listing folders to see what's here`, `The list is already in front of it`],
    [`Where it looks first`, `The top, then downwards`, `The project it was opened in`],
    [`When you rename a folder`, `Old notes keep naming the old one`, `Read again next conversation`],
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

        <!-- ② Project map — one question earlier than ①. Worth being precise about two things: that it is read
             fresh rather than stored (that is the whole reason it isn't a note you'd write yourself), and that
             it follows where the conversation was opened rather than always starting at the top. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Project map</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Before it can search for anything, the assistant has to know what it is looking at. With this on, the sandbox reads your folders when a
            conversation opens and hands over a short list — the main parts of the project, what each one is for, how big it is, and which one the
            conversation started in.
        </p>
        <InfoTable class="mt-2" :headers="[``, `Off — it looks around first`, `On — handed the layout`]" :rows="MAP_COMPARISON" />
        <p class="mt-1.5 text-2xs text-subtle">
            Each part's description is taken from that folder's own package details or the first line of its README, so it says what your project says
            about itself and nothing is made up. Folders with neither are listed by name and size.
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            It follows the conversation. Open one in a particular project and that project is what gets mapped, with the rest of the workspace named
            on one line — an assistant working three folders deep isn't asking about the others.
        </p>
        <div class="mt-2 flex items-start gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2">
            <Icon name="refresh" class="mt-0.5 shrink-0 text-2xs text-subtle" />
            <p class="text-2xs text-muted">
                <span class="font-medium text-content">Read fresh, never stored.</span> This is the difference between it and writing the same list
                into a notes file yourself: the map is re-read every time a conversation opens, so renaming or adding a folder needs nothing from you.
                A written one drifts the first time the project moves, and nobody notices until the assistant spends a turn looking for something that
                isn't there any more. Sent once per conversation, and you can read exactly what was sent — it appears above your first message.
            </p>
        </div>
    </InfoDialog>
</template>
