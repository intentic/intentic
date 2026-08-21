<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";

/* The (i) beside the Agent tab's "Subagents" group. Three numbers that all sound like "how many agents", so the
 * dialog's whole job is to say which question each one answers and where you meet it: the wall you hit tells
 * you which row to move, and without that all three read as the same setting spelled three ways.
 *
 * Defaults quoted here come from SandboxSettingsSchema: 20 / 200 / 3, which are the Claude Code CLI's own. */

const WHICH_CAP = [
    [`Subagents at once`, `A single fan-out stops part-way and the rest run after`, `A wide sweep: many files, many checks, all at the same time`],
    [`Subagents per conversation`, `A long conversation stops delegating entirely`, `Hours in one chat, or a workflow that keeps spawning rounds`],
    [`Nesting depth`, `An agent's own agent is refused`, `Work that splits, then splits again: a lead agent running its own team`],
];
</script>

<template>
    <InfoDialog title="Subagents">
        <p class="text-sm text-muted">
            The assistant can hand a piece of work to another agent: a search across the whole repo, a second opinion, a long build it doesn't need
            to watch. Each one runs on its own and reports back. These three numbers bound how many of them there can be.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Which one you've hit</h3>
        <p class="mt-1.5 text-2xs text-muted">
            They stop different things, so the symptom names the row. Raising just the first is the common mistake: a fan-out that clears it lands on
            the second a few rounds later, and it looks like the same wall moved.
        </p>
        <InfoTable class="mt-2" :headers="[``, `What you see`, `When it bites`]" :rows="WHICH_CAP" />

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">What happens at the limit</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Nothing fails. The assistant is told it has reached the limit and told not to retry, so it does the remaining work itself, one piece at a
            time. That is why a low number costs you speed rather than an error, and why an unexplained slow patch on a big task is worth checking
            here.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">What raising them costs</h3>
        <p class="mt-1.5 text-2xs text-muted">
            Every agent is a model running against your allowance, so twenty at once is twenty conversations being paid for at once: the ceiling is
            what stops a single instruction from becoming a fleet. Your sandbox's own CPU and memory are the other bound, and the assistant cannot
            raise any of this itself: it can only ask you to.
        </p>
        <p class="mt-1.5 text-2xs text-subtle">
            Left alone, all three stay exactly where the Claude Code CLI puts them: 20 at once, 200 per conversation, 3 deep. What you spend is on
            <span class="font-medium text-content">Usage</span>, and what is running right now is on
            <span class="font-medium text-content">Subagents</span> in the sidebar.
        </p>
    </InfoDialog>
</template>
