<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";

/* The (i) beside the Agent tab's "Skills" group. Three things a reader needs and cannot get from the list: what a
 * skill actually is (the word is used loosely everywhere and means something specific here), where each origin
 * comes from and therefore who can change it, and the one counter-intuitive fact — that having more of them is not
 * free, which is the reason a switch exists at all. */

const ORIGINS = [
    [`Yours`, `You wrote it here`, `Edit, switch off, or delete it`],
    [`Built in`, `Ships with this sandbox`, `Switch it off`],
    [`Connection`, `Came with a tool, machine or account you connected`, `Goes when you disconnect that`],
    [`Extension`, `Ships inside an installed extension`, `Switch the extension off`],
    [`Plugin`, `Ships inside a plugin you installed`, `Remove the plugin`],
    [`Loose file`, `Sitting in the skills folder — by hand, or written by the agent`, `Delete it`],
];
</script>

<template>
    <InfoDialog title="Skills">
        <p class="text-sm text-muted">
            A skill is a note the assistant reads when a job matches it — how to do one particular thing, written once. It's not code and it doesn't
            run: it's instructions, plus a line saying when to reach for them.
        </p>
        <p class="mt-2 text-sm text-muted">
            This is everything your agent is carrying right now, wherever it came from. Six different things put skills in front of it, so the list is
            the only place the whole set is visible at once.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Where they come from</h3>
        <InfoTable class="mt-2" :headers="[`Kind`, `Where it came from`, `What you can do`]" :rows="ORIGINS" />

        <!-- The one thing about this list that surprises people, and the reason the switches are worth using. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">More isn't better</h3>
        <p class="mt-1.5 text-2xs text-muted">
            The assistant reads every skill's "when to use it" line on every single turn, so each one you keep costs a little attention on work it has
            nothing to do with. A short list the assistant reads properly beats a long one it skims. Switching a skill off keeps what you wrote — it
            just stops being handed over.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Writing a good one</h3>
        <p class="mt-1.5 text-2xs text-muted">
            The "when to use it" line does the work. It's the only part read before the assistant decides whether to open the rest, so name the words
            and situations it should trigger on rather than describing the skill in the abstract. A skill nobody can tell when to use is a skill that
            never gets used, and nothing on screen looks wrong when that happens.
        </p>
        <p class="mt-1.5 text-2xs text-subtle">Changes land on the next turn — a conversation already running keeps the skills it started with.</p>
    </InfoDialog>
</template>
