<script setup lang="ts">
import { InfoDialog, InfoTable } from "@intentic/ui";

/* The (i) beside the Agent tab's "Finished work" group — what happens to an agent's work once it stops, and to
 * the agent itself. Both settings spend something real if you leave them alone: one leaves finished work
 * waiting for you, the other keeps a whole checkout of your repository per agent, forever.
 *
 * Archiving gets a lifecycle strip rather than prose because it IS a lifecycle, and then the kept/released
 * split, which is the only fact that makes an automatic sweep acceptable at all.
 *
 * Defaults quoted here come from SandboxSettingsSchema — on / 3 days. */

const AT_A_GLANCE = [
    [`Land finished work automatically`, `Whether clean work reaches your workspace by itself`, `On`],
    [`Archive finished agents`, `How long finished work stays on the board`, `3 days`],
];
</script>

<template>
    <InfoDialog title="Finished work">
        <p class="text-sm text-muted">What happens after an agent stops — to its work, and to the agent.</p>
        <InfoTable class="mt-2" :headers="[`Setting`, `What it changes`, `Default`]" :rows="AT_A_GLANCE" />

        <!-- ① Landing — the difference is who moves the work, and the honest framing is that OFF is a queue you
             have to visit. Neither is the safe option: one applies work you haven't read, the other lets it
             pile up on branches. -->
        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Land finished work automatically</h3>
        <p class="mt-1.5 text-2xs text-muted">
            An agent works on its own branch, in its own checkout. Landing is the step that brings that work back to your workspace as uncommitted
            changes — the same state as if you'd made the edits yourself, ready to read, amend or throw away.
        </p>
        <div class="mt-2 grid gap-2 sm:grid-cols-2">
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">On — the default</p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    A clean finish applies straight away. You come back to the work already in your workspace, and nothing is waiting on you to notice
                    it.
                </p>
            </div>
            <div class="overflow-hidden rounded-lg border border-line">
                <p class="border-b border-line bg-canvas px-2.5 py-1 text-2xs font-medium uppercase tracking-wide text-subtle">Off</p>
                <p class="px-2.5 py-2 text-2xs text-muted">
                    Every clean finish becomes a <span class="font-medium text-content">Ready to land</span> card. Nothing touches your workspace
                    until you press it, from the board or the review.
                </p>
            </div>
        </div>
        <p class="mt-1.5 text-2xs text-subtle">
            It's a sandbox-wide default rather than a browser preference because agents started by an automation — Discord, a webhook, a scheduled
            wake-up — finish their turns with no browser in the room. Any single agent can disagree with it from the hold toggle on its review panel;
            agents without an opinion follow this wherever it points next. Work that ends with a conflict or a failure never lands by itself.
        </p>

        <!-- ② Archiving — a lifecycle, so a lifecycle strip, then the kept/released split it turns on. -->
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
