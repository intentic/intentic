<script setup lang="ts">
import { COMMAND_RULE_CATALOG, type CommandRule } from "@intentic/sandbox-contract";
import { DisclosureRow, RowGroup, RowNote } from "@intentic/ui";
import { computed, ref } from "vue";

/* WHAT THE GATE STOPS, LISTED, and the reason this group exists at all.
 *
 * THE COMPLAINT IT ANSWERS was a card asking to approve `docker volume rm` against a smoke-test container. Two
 * things were wrong with that card and only one of them was a bug. The bug was the rule (the catalog now reads
 * container state as its own class and the sandbox's hard rule no longer holds it). The other thing was that
 * there was nowhere to go and look: the page offered a switch, a prose policy and a log of decisions already
 * made, and no answer at all to "what is going to interrupt me, and which of it can I change?". An owner
 * reading their own policy cannot tell which of it is being applied and which is being overruled by something
 * typed, which is exactly the question a card raises and this group answers.
 *
 * THE SPLIT IS BY WHETHER THEY GET A SAY, not by class, not by severity. That is the only cut that changes what
 * somebody does next: one list is worth editing the policy over, the other is not editable by anyone and
 * saying so plainly is kinder than letting them write a line that will never fire.
 *
 * AND BY MACHINE, because the same command is two different acts. The hard rule in this container is three
 * things; on somebody's laptop it is everything that deletes, and that difference is the substance of the
 * design rather than a footnote to it.
 *
 * READ-ONLY, DELIBERATELY. Every line here comes from the contract (safety-policy.ts COMMAND_RULE_CATALOG),
 * which is the same constant both gates consult, so this cannot drift from enforcement the way a hand-written
 * list of the same facts would. It is also why there are no controls: the tuning surface for all of it is the
 * policy document below, and a regex box on a settings page is a way to switch off a disk-wipe guard with a
 * typo. If a pattern here is wrong, the fix is a line in the policy or a change to the catalog, not a field. */

const MACHINES = [
    { locus: `sandbox`, label: `This sandbox`, note: `A disposable container. /work is a git worktree; /history holds every other agent's work.` },
    { locus: `device`, label: `My devices`, note: `Your own computers, reached over the tunnel. Nothing on them is rebuilt from an image.` },
] as const;

const rulesAt = (locus: `sandbox` | `device`, tier: `hard` | `judged`): readonly CommandRule[] =>
    COMMAND_RULE_CATALOG[locus].filter((rule) => rule.tier === tier);

/* The judged list is the same everywhere it is the same, which it nearly is: only the two classes that move
 * tiers differ between the machines. So it is drawn once from the sandbox's side and the difference is stated
 * in the hard-rule block above it, rather than printing two near-identical columns and making a reader diff
 * them. */
const judged = computed(() => rulesAt(`sandbox`, `judged`));

/* WHICH OF THE JUDGED LIST IS HELD ON A DEVICE, named rather than left to be worked out. Two of these classes
 * appear in BOTH disclosures — judged here, un-waivable on a laptop — and a reader who spots the same words
 * twice with no explanation concludes the page is confused rather than that the machines differ. Derived, so
 * moving a class between tiers rewrites this sentence instead of stranding it. */
const heldOnDevices = computed(() =>
    judged.value.filter((rule) => COMMAND_RULE_CATALOG.device.find((entry) => entry.commandClass === rule.commandClass)?.tier === `hard`),
);

// Both start closed: the group's own note is the answer for most readers, and a settings page that opens two
// long lists on arrival buries the policy editor under them.
const openHard = ref(false);
const openJudged = ref(false);
</script>

<template>
    <RowGroup label="What gets stopped">
        <RowNote>
            A command is only ever looked at if it matches one of these. Everything else runs without a model reading it and without anything being
            recorded.
        </RowNote>

        <!-- The un-waivable half first, because it is the half somebody cannot act on and therefore the half
             worth knowing before they spend time writing a policy line about it. -->
        <DisclosureRow
            v-model:open="openHard"
            icon="lock"
            title="Never judged"
            description="Always asks. No policy line and no verdict can allow these."
        >
            <template #below>
                <div class="flex flex-col gap-4">
                    <p class="text-2xs text-muted">
                        These are held even with the judge switched off, because nothing in this product brings the state back. They are typed rather
                        than written, so they are the one part of this page you cannot change.
                    </p>
                    <!-- THE MACHINE IS A HEADING, NOT ANOTHER ROW. Drawn first as plain medium text at the
                         rules' own left edge, it was the same size, weight and colour as the rule labels under
                         it, so the one block whose entire point is that the two machines differ read as six
                         undifferentiated lines. Uppercase and tracked is how this app already spells a divider
                         inside a group (the RowGroup label above it, AgentSafetyLog, CodeSearchInfo), and the
                         rail on the list is what says where one machine's rules end. -->
                    <section v-for="machine in MACHINES" :key="machine.locus" class="flex flex-col gap-1.5">
                        <h4 class="text-2xs font-semibold tracking-wide text-content uppercase">{{ machine.label }}</h4>
                        <p class="text-2xs text-subtle">{{ machine.note }}</p>
                        <ul class="border-line-subtle flex flex-col gap-2 border-l pl-3">
                            <li v-for="rule in rulesAt(machine.locus, `hard`)" :key="rule.commandClass" class="flex flex-col gap-0.5">
                                <span class="text-2xs text-content">{{ rule.label }}</span>
                                <span class="text-2xs text-muted">{{ rule.patterns.join(` · `) }}</span>
                                <span v-if="rule.note" class="text-2xs text-subtle">{{ rule.note }}</span>
                            </li>
                        </ul>
                    </section>
                </div>
            </template>
        </DisclosureRow>

        <DisclosureRow
            v-model:open="openJudged"
            icon="eye"
            title="Gets a second look"
            description="The judge reads your policy and decides. Usually it allows them."
        >
            <template #below>
                <div class="flex flex-col gap-4">
                    <p class="text-2xs text-muted">
                        Matching one of these is not a finding, it is a reason to look: most of what lands here is ordinary work a pattern caught by
                        accident. Write a line in your policy below to stop being asked about any of it.
                    </p>
                    <!-- Why two of these words appear in both lists. Without it the page reads as contradicting
                         itself rather than as describing two machines.

                         The labels are VERB PHRASES ("delete files recursively"), so they cannot sit inside a
                         sentence: "On your own computers delete files recursively … always asks instead" reads
                         as an instruction to delete things. They go in a list after a colon instead. -->
                    <p v-if="heldOnDevices.length > 0" class="text-2xs text-muted">
                        <span class="text-content">This is the list for the sandbox.</span> On your own computers, these always ask instead:
                        {{ heldOnDevices.map((rule) => rule.label).join(`; `) }}.
                    </p>
                    <ul class="flex flex-col gap-1.5">
                        <li v-for="rule in judged" :key="rule.commandClass" class="flex flex-col gap-0.5">
                            <span class="text-2xs text-content">{{ rule.label }}</span>
                            <span class="text-2xs text-muted">{{ rule.patterns.join(` · `) }}</span>
                        </li>
                    </ul>
                    <!-- The one thing a reader of this list will otherwise get wrong, and the thing the old
                         behaviour actually got wrong: a command that TALKS about a delete is not one. -->
                    <p class="text-2xs text-subtle">
                        A command that only mentions one of these — printed by an <code>echo</code>, searched for by a <code>grep</code>, written into
                        a heredoc — is not doing it, and never reaches the rule above.
                    </p>
                </div>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
