<script setup lang="ts">
import { ui, Icon, Popover } from "@intentic/extension-ui";
import { ref } from "vue";
import type { useTargets } from "./useTargets";

// A group's address, shown only when the heading above hasn't already answered it: aimed somewhere other than the
// repo's dev server, or nothing to inherit (several apps, none chosen). Silent otherwise, or every group would repeat
// the heading's own address. Offered as choices from the daemon's known apps, not retyped from a terminal.

const { repo, group, targets } = defineProps<{
    repo: string;
    group: string;
    targets: ReturnType<typeof useTargets>;
}>();

const popover = ref<InstanceType<typeof Popover> | null>(null);
const toggle = (event: Event): void => popover.value?.toggle(event);

// True only in the two cases the heading hasn't already answered: aimed elsewhere, or nothing this row can fix (a
// stopped server's fix is Start, on the heading, not here).
const stated = (): boolean => targets.isElsewhere(repo, group) || targets.needsAddress(repo, group);

// Offers the repo's own apps by name whenever this group actually has a choice: several serving, or none chosen yet;
// never substitutes a sibling app when there's only one.
const picks = (): ReturnType<typeof targets.serversOf> =>
    targets.serversOf(repo).length > 1 || targets.addressOf(repo, group) === undefined ? targets.serversOf(repo) : [];

// Which app an address belongs to, named by its package, since a bare port is unrecognizable; undefined when the
// address isn't one this repo is serving (e.g. staging).
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

    <!-- Quiet until hovered, since the heading above already answered this. -->
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
            <!-- The repo's own apps, offered by name, only when there are several or this group has nothing chosen yet. -->
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
            <!--
                Typed straight into the aiming state, so the chip, gate and manifest all read the same value; clearing hands the group back to the
                repo's server, or leaves it unaddressed.
            -->
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
            <!-- Once apps are listed there's no "leave it to the repo" option: the run remembers the pick, so this is asked once, not once per run. -->
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
