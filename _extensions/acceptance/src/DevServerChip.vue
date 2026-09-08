<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { ui, Icon, Popover, vAction } from "@intentic/extension-ui";
import { ref } from "vue";
import { host } from "./host";
import { panelSessionOf, type useTargets } from "./useTargets";

// One repo's dev server, shown once on its heading rather than once per story group. Ambient, not part of composing a
// run: the chip opens the terminal actually serving it, and stays visible through none/starting/address rather than
// disappearing once a process spawns. Several addresses show as a count, with a per-package list one click away.

const { repo, targets, blocked } = defineProps<{
    repo: string;
    targets: ReturnType<typeof useTargets>;
    // A selected group is waiting on this server; tints the chip so the note above points somewhere findable.
    blocked?: boolean;
}>();

const starting = ref(false);
const failure = ref<string | undefined>(undefined);
const popover = ref<InstanceType<typeof Popover> | null>(null);

const start = async (): Promise<void> => {
    starting.value = true;
    failure.value = undefined;
    try {
        await targets.startPanel(repo);
    } catch (error) {
        failure.value = errorMessage(error);
    } finally {
        starting.value = false;
    }
};
</script>

<template>
    <!-- Says so rather than showing an inert dot, so silence here doesn't read as "not started yet". -->
    <span v-if="targets.stateOf(repo) === `none`" class="text-2xs text-subtle">no dev server</span>

    <!--
        Not a <Notice>: this is an inline chip that truncates and carries its text in a tooltip, not a block that owns its own line. Borrows the
        danger tint directly rather than a shared recipe, which is how that recipe drifted into non-notices elsewhere.
    -->
    <span v-else-if="failure" class="truncate rounded-lg border border-danger/40 bg-danger/10 px-2 py-0.5 text-2xs text-danger" :title="failure">{{
        failure
    }}</span>

    <!-- Ready, serving one thing, from a terminal: the address is the label, and is itself the button that opens it. -->
    <button
        v-else-if="targets.terminalOf(repo) !== undefined"
        type="button"
        :class="ui.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`Open the terminal serving this: ${targets.terminalOf(repo)}`"
        @click="host().terminal.open(targets.terminalOf(repo) ?? ``)"
    >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        <span class="font-mono">{{ targets.localUrl(repo) }}</span>
        <Icon name="desktop" class="text-subtle" />
    </button>

    <!-- Same ready state without a terminal to open; the click opens the popover instead, answering "where is this running". -->
    <button
        v-else-if="targets.localUrl(repo) !== undefined"
        type="button"
        :class="ui.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`What this repository is serving`"
        @click="popover?.toggle($event)"
    >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        <span class="font-mono">{{ targets.localUrl(repo) }}</span>
        <Icon name="chevron-down" class="text-subtle" />
    </button>

    <!-- Ready, serving several: a count instead of a wall of addresses, with the list one click away, each named by package. -->
    <button
        v-else-if="targets.stateOf(repo) === `ready`"
        type="button"
        :class="ui.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`What this repository is serving`"
        @click="popover?.toggle($event)"
    >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        {{ targets.serversOf(repo).length }} servers
        <Icon name="chevron-down" class="text-subtle" />
    </button>

    <!--
        Starting: where Start used to vanish, and where the boot's output lives, since `starting` means the daemon spawned it but nothing has bound a
        port yet.
    -->
    <button
        v-else-if="targets.stateOf(repo) === `starting`"
        type="button"
        :class="ui.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`A first start installs dependencies, which can take a minute: watch it in the terminal`"
        @click="host().terminal.open(panelSessionOf(repo))"
    >
        <Icon name="spinner" spin class="shrink-0 text-subtle" />
        Starting…
        <Icon name="desktop" class="text-subtle" />
    </button>

    <button
        v-else
        type="button"
        :disabled="starting"
        :class="ui.linkButton(`gap-1.5 text-2xs hover:no-underline`, blocked ? `text-warning hover:text-warning` : `text-muted hover:text-content`)"
        v-tooltip.bottom="`Start this repository's dev server`"
        v-action="start"
    >
        <Icon name="play" class="shrink-0" />
        Start dev server
    </button>

    <!--
        Each row: an address, the package that bound it, and its terminal, since knowing where the output lives is the difference between reading
        this list and acting on it.
    -->
    <Popover ref="popover">
        <div class="flex w-pop-sm flex-col gap-2 p-1">
            <p class="text-sm font-medium text-content">
                <span class="font-mono">{{ repo }}</span> is serving {{ targets.serversOf(repo).length }}
                {{ targets.serversOf(repo).length === 1 ? `app` : `apps` }}
            </p>
            <div v-for="server in targets.serversOf(repo)" :key="server.url" class="flex items-baseline gap-2">
                <span class="h-1.5 w-1.5 shrink-0 -translate-y-0.5 rounded-full bg-success" />
                <span class="font-mono text-2xs text-content">{{ server.url }}</span>
                <span class="ml-auto flex shrink-0 items-baseline gap-2">
                    <span v-if="server.dir" class="font-mono text-2xs text-subtle">{{ server.dir }}</span>
                    <button
                        v-if="server.session"
                        type="button"
                        :class="ui.linkButton(`gap-1 text-2xs text-muted hover:text-content hover:no-underline`)"
                        v-tooltip.bottom="`Open ${server.session}: the terminal this is running in`"
                        @click="host().terminal.open(server.session)"
                    >
                        <Icon name="desktop" class="shrink-0" />
                        {{ server.session }}
                    </button>
                    <span
                        v-else
                        class="text-2xs text-subtle"
                        v-tooltip.bottom="
                            `Nothing in this sandbox's terminals is serving it: it answers from outside them, so there is no output to show here and no session to stop.`
                        "
                    >
                        no terminal
                    </span>
                </span>
            </div>
            <!--
                Placed where the count is read: with several apps behind one dev script, only each group's own row says which app its stories are
                walked against.
            -->
            <p v-if="targets.serversOf(repo).length > 1" class="text-2xs text-subtle">
                Each group below says which of these its stories are walked against: the dev server is shared, the addresses are not.
            </p>
        </div>
    </Popover>
</template>
