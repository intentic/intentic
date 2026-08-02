<script setup lang="ts">
import { cmp, Icon, InputText, Popover } from "@intentic/extension-ui";
import { ref } from "vue";
import type { useTargets } from "./useTargets";

/* WHERE ONE STORY GROUP AIMS — and, almost always, nothing at all.
 *
 * A group's address is a real fact of a run (a monorepo's marketing site and its web app are two ports behind one
 * `pnpm dev`, and the group is the only thing in a stories tree that says which is which), but it is the same
 * answer for nearly every group nearly every time: the repository's dev server, whose state the heading above
 * already shows. So this renders NOTHING in that case. Printing "→ http://localhost:5173" under a heading that
 * just said `● http://localhost:5173` is how the old dialog grew a screen of cards that all agreed with each other.
 *
 * What is left is the exception, stated only when it is true: a group aimed somewhere else reads its address, and
 * a repo the daemon runs nothing for reads an invitation to give it one. Aiming a group elsewhere costs a click on
 * an affordance that appears under the pointer — an exception should cost a gesture, not a permanent line of chrome
 * on every group in the workspace. */

const { repo, group, targets } = defineProps<{
    repo: string;
    group: string;
    targets: ReturnType<typeof useTargets>;
}>();

const popover = ref<InstanceType<typeof Popover> | null>(null);
const toggle = (event: Event): void => popover.value?.toggle(event);

/* SPOKEN, rather than left to the hover affordance, in exactly the two cases where the heading above has not
 * already answered: this group points somewhere other than the repo's dev server, or the repo has no dev server
 * for it to point at. Note what is NOT here — a stopped server. That blocks the run, but the fix is Start and Start
 * lives on the heading, so shouting about it here would put the alarm somewhere the remedy isn't. */
const stated = (): boolean => targets.isElsewhere(repo, group) || targets.stateOf(repo) === `none`;
</script>

<template>
    <button
        v-if="stated()"
        type="button"
        :class="
            cmp.linkButton(
                `gap-1.5 font-mono text-2xs hover:no-underline`,
                targets.addressOf(repo, group) === undefined ? `text-warning hover:text-warning` : `text-muted hover:text-content`,
            )
        "
        v-tooltip.bottom="`Point this group at a different address`"
        @click="toggle"
    >
        <Icon name="arrow-right" class="shrink-0 text-subtle" />
        {{ targets.addressOf(repo, group) ?? `needs an address` }}
    </button>

    <!-- The default. Quiet until the row is under the pointer: the heading above already answered this. -->
    <button
        v-else
        type="button"
        :class="cmp.linkButton(`gap-1.5 text-2xs text-muted opacity-0 group-hover:opacity-100 hover:no-underline focus-visible:opacity-100`)"
        v-tooltip.bottom="`Point this group at a different address`"
        @click="toggle"
    >
        <Icon name="arrow-right" class="shrink-0" />
        aim elsewhere
    </button>

    <Popover ref="popover">
        <div class="flex w-80 flex-col gap-2 p-1">
            <p class="text-sm font-medium text-content">Where does this group's app answer?</p>
            <!-- Typed straight into the aiming state, so the chip, the gate and the run's manifest all read one
                 value. Clearing it is meaningful: on a repo with a dev server it hands the group back, and on one
                 without it leaves the group with nowhere to point, which the header then says out loud. -->
            <InputText
                :model-value="targets.addressOf(repo, group) ?? ``"
                placeholder="http://localhost:5173"
                class="w-full text-sm"
                @update:model-value="targets.aimAt(repo, group, $event ?? ``)"
            />
            <p v-if="targets.stateOf(repo) === `none`" class="text-2xs text-subtle">
                The daemon runs no dev server for <span class="font-mono">{{ repo }}</span> — start the app yourself in a terminal, or point at a
                deployment. The agents reach it from inside the sandbox, so a localhost address is the direct route.
            </p>
            <template v-else>
                <p class="text-2xs text-subtle">
                    Leave this to <span class="font-mono">{{ repo }}</span
                    >'s own dev server unless this group is a second app — a marketing site on its own port, or a deployment you want walked instead.
                </p>
                <button
                    v-if="targets.isElsewhere(repo, group)"
                    type="button"
                    :class="cmp.linkButton(`text-2xs text-muted hover:text-content`)"
                    @click="targets.aimAt(repo, group, undefined)"
                >
                    Use {{ repo }}'s dev server
                </button>
            </template>
        </div>
    </Popover>
</template>
