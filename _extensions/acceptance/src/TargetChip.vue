<script setup lang="ts">
import { ui, Icon, Popover } from "@intentic/extension-ui";
import { ref } from "vue";
import type { useTargets } from "./useTargets";

/* WHERE ONE STORY GROUP AIMS, and, almost always, nothing at all.
 *
 * A group's address is a real fact of a run (a monorepo's marketing site and its web app are two ports behind one
 * `pnpm dev`, and the group is the only thing in a stories tree that says which is which), but it is the same
 * answer for nearly every group nearly every time: the repository's dev server, whose state the heading above
 * already shows. So this renders NOTHING in that case. Printing "→ http://localhost:5173" under a heading that
 * just said `● http://localhost:5173` is how the old dialog grew a screen of cards that all agreed with each other.
 *
 * What is left is the exception, stated only when it is true: a group aimed somewhere else reads its address, and
 * a repo the daemon runs nothing for reads an invitation to give it one. Aiming a group elsewhere costs a click on
 * an affordance that appears under the pointer: an exception should cost a gesture, not a permanent line of chrome
 * on every group in the workspace.
 *
 * A REPO SERVING SEVERAL APPS MAKES EVERY GROUP THE EXCEPTION, which is the point: there is no repo-level address
 * to inherit, so each group states which app it walks. Those addresses arrive as CHOICES rather than as something
 * to retype from the terminal: the daemon already knows the ports and which package bound each. */

const { repo, group, targets } = defineProps<{
    repo: string;
    group: string;
    targets: ReturnType<typeof useTargets>;
}>();

const popover = ref<InstanceType<typeof Popover> | null>(null);
const toggle = (event: Event): void => popover.value?.toggle(event);

/* SPOKEN, rather than left to the hover affordance, in exactly the two cases where the heading above has not
 * already answered: this group points somewhere other than the repo's dev server, or it has nothing to point at
 * that this row can fix (see needsAddress: a stopped server is not that, because Start lives on the heading).
 *
 * THE SECOND CLAUSE USED TO READ `stateOf === none`, which quietly left out the very case this chip's existence
 * is argued from: a repo serving several apps, none of them yet chosen for this group. The group was blocked, the
 * run button was dead, the heading was green, and the one control that could unblock it was the invisible
 * hover affordance below. */
const stated = (): boolean => targets.isElsewhere(repo, group) || targets.needsAddress(repo, group);

/* THE REPO'S APPS, OFFERED BY NAME: whenever this group actually has a choice to make. Several answering is one
 * such moment; the other is a group with NO address, which is now reachable with a single app serving (a monorepo
 * mid-boot, or a memory whose port has gone: aimOf refuses to substitute a sibling app for either). That case
 * used to fall through to the bare text field, so the remedy for "needs an address" was to read a port off a
 * terminal and retype it. A repo already serving the answer should never ask anyone to type it. */
const picks = (): ReturnType<typeof targets.serversOf> =>
    targets.serversOf(repo).length > 1 || targets.addressOf(repo, group) === undefined ? targets.serversOf(repo) : [];

/* WHICH APP THAT ADDRESS IS, named by the package that bound it. A port is not a thing anyone recognises: the
 * marketing group in this workspace read `→ https://localhost:47145` for three runs and nobody could see from the
 * row that it was the web app. `_editor/web` on a group of landing-page stories is wrong at a glance, which is
 * the only kind of wrong a list of groups can catch. Undefined when the address is not one the repo is serving:
 * a staging deployment names itself. */
const app = (): string | undefined => targets.serversOf(repo).find((server) => server.url === targets.addressOf(repo, group))?.dir;
</script>

<template>
    <button
        v-if="stated()"
        type="button"
        :class="
            ui.linkButton(
                `gap-1.5 font-mono text-2xs hover:no-underline`,
                targets.addressOf(repo, group) === undefined ? `text-warning hover:text-warning` : `text-muted hover:text-content`,
            )
        "
        v-tooltip.bottom="`Point this group at a different address`"
        @click="toggle"
    >
        <Icon name="arrow-right" class="shrink-0 text-subtle" />
        {{ targets.addressOf(repo, group) ?? `needs an address` }}
        <span v-if="app()" class="text-subtle">{{ app() }}</span>
    </button>

    <!-- The default. Quiet until the row is under the pointer: the heading above already answered this. -->
    <button
        v-else
        type="button"
        :class="ui.linkButton(`gap-1.5 text-2xs text-muted opacity-0 group-hover:opacity-100 hover:no-underline focus-visible:opacity-100`)"
        v-tooltip.bottom="`Point this group at a different address`"
        @click="toggle"
    >
        <Icon name="arrow-right" class="shrink-0" />
        aim elsewhere
    </button>

    <Popover ref="popover">
        <div class="flex w-80 flex-col gap-2 p-1">
            <p class="text-sm font-medium text-content">Where does this group's app answer?</p>
            <!-- The repo's own apps, offered by name, when there are several, and when this group has nothing to
                 point at yet. A repo serving one thing that this group already inherited needs no list: that is a
                 question with an obvious answer, already answered. -->
            <template v-if="picks().length > 0">
                <button
                    v-for="server in picks()"
                    :key="server.url"
                    type="button"
                    :class="[
                        `flex items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-subtle`,
                        targets.addressOf(repo, group) === server.url ? `bg-subtle` : ``,
                    ]"
                    @click="targets.aimAt(repo, group, server.url)"
                >
                    <Icon
                        :name="targets.addressOf(repo, group) === server.url ? `check` : `arrow-right`"
                        class="shrink-0 translate-y-px"
                        :class="targets.addressOf(repo, group) === server.url ? `text-success` : `text-subtle`"
                    />
                    <span class="font-mono text-2xs text-content">{{ server.url }}</span>
                    <span v-if="server.dir" class="ml-auto font-mono text-2xs text-subtle">{{ server.dir }}</span>
                </button>
                <p class="text-2xs text-subtle">…or an address of your own:</p>
            </template>
            <!-- Typed straight into the aiming state, so the chip, the gate and the run's manifest all read one
                 value. Clearing it is meaningful: on a repo with a dev server it hands the group back, and on one
                 without it leaves the group with nowhere to point, which the header then says out loud. -->
            <input
                :value="targets.addressOf(repo, group) ?? ``"
                type="text"
                placeholder="http://localhost:5173"
                :class="ui.input(`w-full`)"
                @input="targets.aimAt(repo, group, ($event.target as HTMLInputElement).value)"
            />
            <p v-if="targets.stateOf(repo) === `none`" class="text-2xs text-subtle">
                The daemon runs no dev server for <span class="font-mono">{{ repo }}</span>: start the app yourself in a terminal, or point at a
                deployment. The agents reach it from inside the sandbox, so a localhost address is the direct route.
            </p>
            <!-- Once the apps are listed there is no "leave it to the repo" to offer: the choice above IS the
                 answer, and the run remembers it so this is asked once rather than once per run. -->
            <p v-else-if="picks().length > 0" class="text-2xs text-subtle">
                Pick the app these stories belong to. The next run against this group starts here, so this is a question you answer once.
            </p>
            <template v-else>
                <p class="text-2xs text-subtle">
                    Leave this to <span class="font-mono">{{ repo }}</span
                    >'s own dev server unless this group is a second app: a marketing site on its own port, or a deployment you want walked instead.
                </p>
                <button
                    v-if="targets.isElsewhere(repo, group)"
                    type="button"
                    :class="ui.linkButton(`text-2xs text-muted hover:text-content`)"
                    @click="targets.aimAt(repo, group, undefined)"
                >
                    Use {{ repo }}'s dev server
                </button>
            </template>
        </div>
    </Popover>
</template>
