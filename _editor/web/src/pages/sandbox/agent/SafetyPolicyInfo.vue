<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";

/* The (i) beside the Safety policy. Two things somebody needs before they write a line of it and cannot get
 * from a textarea: what actually happens to a command, and — the part that decides whether this page is worth
 * taking seriously — what the document does NOT control. */

const TIERS = [
    [`The sandbox itself`, `A container, a git worktree of its own, credentials masked out of everything the model reads`, `Nobody. Nothing here can change it.`],
    [`A quick pattern match`, `Spots the handful of commands worth a second look, and is wrong often`, `Nobody`],
    [`A model reading your policy`, `Applies what you wrote to this command, plus what the sandbox knows about the turn`, `Nobody, unless it decides to ask`],
    [`You`, `A card, with the model's one-sentence reason on it`, `You`],
];
</script>

<template>
    <InfoDialog title="Safety policy">
        <p class="text-sm text-muted">
            Your assistant runs commands on its own. This is where you say which of them are worth interrupting you about. It's prose because the
            thing reading it is a model: it can tell a script being written to a file from a directory actually being deleted, which a list of
            rules can't.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">What happens to a command</h3>
        <InfoTable class="mt-2" :headers="[`Step`, `What it does`, `Who it interrupts`]" :rows="TIERS" />

        <!-- The honest limit, and the reason the page is safe to hand to the assistant. Without this an owner
             either over-trusts the document (thinking it is the boundary) or under-uses it (afraid a loose line
             opens the machine up). Neither is true and the difference is worth two paragraphs. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">What this can and cannot do</h3>
        <p class="mt-2 text-2xs text-muted">
            It decides <span class="font-medium text-content">how often you are interrupted</span>, not what the assistant is capable of. Nothing
            written here can let it out of its container, widen what one of your devices allows, or show it a credential — those are enforced
            elsewhere and are not editable from this page. The worst a bad line can do is stop asking you about something you wanted to see.
        </p>
        <p class="mt-2 text-2xs text-muted">
            That is also why the assistant may edit this file when you ask it to. It cannot grant itself anything by doing so. It is refused if the
            turn has read something from outside, or if nobody is watching.
        </p>
        <p class="mt-2 text-2xs text-muted">
            One rule sits outside the document: wiping a disk, or deleting anything under <code>/history</code>, always asks. A model can be argued
            into most things by text inside the command it is judging, and those two cost more than any policy line is worth. It is also the one
            rule the <span class="font-medium text-content">Safety judge</span> switch above cannot reach — turning the judge off stops your policy
            being read, not that.
        </p>
    </InfoDialog>
</template>
