<script setup lang="ts">
import { computed, onUnmounted, shallowRef, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { Button, useDevice } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import type { Conversation } from "../../models/conversations/session/conversation";
import { homeConversation, homeConversationFor, homeShownFor } from "../../models/home/homeChat";
import { registry } from "../../models/fleet/useAgents-registry";
import { workLedger } from "../../models/home/homeFacts";
import ChatPane from "../chat/panel/ChatPane.vue";
import HomeChatSlot from "./HomeChatSlot.vue";
import HomeDetour from "./HomeDetour.vue";
import { goInside, homeViewOf } from "../../lib/routes/homeDetour";
import { useRole } from "../../client/sandbox/useRole";
import { switchableSandboxes } from "../../models/sandbox/live/roster";
import HomeNoSandbox from "./HomeNoSandbox.vue";
import { useWorkspaceTree } from "../../models/workspace/tree/useWorkspaceTree";
import { useSandboxAvailability } from "../sandbox/overview/useSandboxAvailability";
import SandboxConnecting from "../sandbox/gates/SandboxConnecting.vue";
import SandboxTooOld from "../sandbox/gates/SandboxTooOld.vue";
import SandboxWarming from "../sandbox/gates/SandboxWarming.vue";
import SandboxOutdatedNotice from "../../parts/sandbox/SandboxOutdatedNotice.vue";
import { daemonTooOld } from "../../client/sandbox/daemon/useDaemonVersion";
import { folderSurface, readFailure, supportsRoute } from "../../client/sandbox/useDaemonRoutes";
import { sandboxEntryPath } from "../../models/sandbox/sandboxScreen";

const t = useT();
const sandbox = useSandbox();
// A view of this sandbox's own shown where the chat is (lib/routes/homeDetour.ts): the chat stays mounted underneath,
// hidden, so going back finds its draft, its scroll and its pane as they were.
const route = useRoute();
const router = useRouter();
const shownView = computed(() => homeViewOf(route.query));
const noSandbox = computed(() => switchableSandboxes(sandbox.sandboxes.value).length === 0);
const { mobile } = useDevice();
const conversation = shallowRef<Conversation>();
// Why the home conversation did not open, in the words of whatever refused it; undefined while nothing has failed.
const failure = shallowRef<string>();
const now = useNow(() => true);
const retry = shallowRef(0);
// The panel the page lends draws exactly this one (models/home/homeChat.ts), and the sandbox it belongs to is said to be
// on screen, which is what a new sandbox's first start waits on (newSandbox/HomeNewSandbox.vue).
watch(
    conversation,
    (open) => {
        homeConversation.value = open;
        homeShownFor.value = open === undefined ? undefined : sandbox.activeSandboxId.value;
    },
    { immediate: true },
);
onUnmounted(() => {
    homeConversation.value = undefined;
    homeShownFor.value = undefined;
});
// Until the home conversation opens, the home stands the sandbox's own gate pages in front of it (SandboxGate.vue): the
// boot chain with its steps while the daemon answers but is still converging, and the wait with its progress, diagnosis
// and ways back while it does not answer at all (a machine waking, a container starting, or something wrong).
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const warming = computed(() => sandbox.reachable.value && availability.value === `warming`);
// A SANDBOX TOO OLD FOR HOME. Home has no SandboxGate in front of it (shell/ShellDesktop.vue), so it stands the gate's
// too-old page itself for a daemon below the oldest this app supports. A daemon above that floor but from before home
// conversations (1.350.0) has no `agents.home` to ask: its hello lists none, and asking anyway answers a 404 no retry
// mends. Home became the first screen after that (1.361.0), so a sandbox left on an older release opened on a failure
// whose Retry could never work, and nothing said that the sandbox only needed updating, or how to get inside it, where
// everything else still works. A folder on this computer lacks routes by nature rather than by age, so no update is
// offered for it; its call fails and says why like any other.
const homeMissing = computed(() => !folderSurface.value && !supportsRoute(`agents.home`));
const tooOldForHome = computed(() => daemonTooOld.value || homeMissing.value);
const enter = (): void => {
    const id = sandbox.activeSandboxId.value;
    if (id !== undefined) {
        void goInside(() => router.push(sandboxEntryPath(id)));
    }
};
const ledger = computed(() => (conversation.value === undefined ? [] : workLedger(registry.value, conversation.value.conversationId, now.value)));
// What has not reached the workspace yet. Its person never lands anything (the daemon lands and commits whatever the home
// merged, turn-landing.ts homeOverride), so this says why, and presses nothing: a clash the home is sent back to resolve
// (`conflict`, the daemon's home-conflict.ts), one only the person's own uncommitted edits make, which no rebase reaches, or work
// held for a maintainer because its person may not land here (`ready`, useRole `canLandHome`).
const { canLandHome } = useRole();
const homeCard = computed(() => registry.value.find((agent) => agent.id === conversation.value?.conversationId));
const heldLine = computed((): string | undefined => {
    const card = homeCard.value;
    if (card?.status === `conflict`) {
        const causes = card.conflictCauses ?? [];
        return causes.length > 0 && causes.every((cause) => cause === `workspace`) ? t(`home.heldYourEdits`) : t(`home.heldConflict`);
    }
    if (card?.status === `ready`) {
        return canLandHome.value ? t(`home.heldNextTurn`) : t(`home.heldForMaintainer`);
    }
    return undefined;
});
watch(
    () => [sandbox.activeSandboxId.value, sandbox.reachable.value, noSandbox.value, tooOldForHome.value, retry.value] as const,
    async ([id, reachable, empty, tooOld], _old, cleanup) => {
        let current = true;
        cleanup(() => {
            current = false;
        });
        failure.value = undefined;
        if (empty || id === undefined || !reachable || tooOld) {
            if (empty) {
                conversation.value = undefined;
            }
            return;
        }
        // Another sandbox's home is not this one's: nothing is said to be on screen until this one's is.
        if (homeShownFor.value !== id) {
            homeShownFor.value = undefined;
        }
        try {
            const home = await sandboxRpc.agents.home(undefined, { context: { at: id, background: true } });
            if (!current) {
                return;
            }
            conversation.value = homeConversationFor(id, home, t(`home.title`));
        } catch (error) {
            if (current) {
                failure.value = readFailure(error);
            }
        }
    },
    { immediate: true },
);
</script>

<template>
    <HomeNoSandbox v-if="noSandbox" />
    <section v-else class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <!-- No top bar over the chat (a sandbox name, status, Open button), by the owner's decision (it came back once already): the
             rail's tile already names the sandbox, double-click or Enter on it goes inside, and the line under the composer
             names it again with the same way in (chat/panel/pane/HomeDoor.vue). -->
        <HomeDetour v-if="shownView" :view="shownView" />
        <details v-if="!shownView && ledger.length" class="shrink-0 border-b border-line px-4 py-2 text-xs" open>
            <summary class="cursor-pointer text-muted">{{ t(`home.work`) }} · {{ ledger.length }}</summary>
            <div class="max-h-40 overflow-auto py-1">
                <div v-for="row in ledger" :key="row.worker.id" class="py-1">
                    <RouterLink :to="`/agents/${encodeURIComponent(row.worker.id)}`" class="flex items-center gap-3 hover:text-link">
                        <span class="min-w-0 flex-1 truncate">{{ row.worker.title ?? row.worker.id }}</span>
                        <span class="text-muted">{{ t(`home.stage.${row.stage}`) }}</span>
                    </RouterLink>
                    <p v-if="row.subject" class="truncate text-muted">{{ row.subject }}</p>
                    <RouterLink
                        v-for="check in row.checks"
                        :key="check.id"
                        :to="`/agents/${encodeURIComponent(check.id)}`"
                        class="ml-3 block truncate py-0.5 text-muted hover:text-link"
                        >{{ check.title ?? t(`home.stage.${check.fresh?.kind === "test" ? "testing" : "reviewing"}`) }}</RouterLink
                    >
                </div>
            </div>
        </details>
        <p v-if="!shownView && heldLine" class="shrink-0 border-b border-line px-4 py-2 text-xs text-muted" role="status">{{ heldLine }}</p>
        <!-- A desktop lends the shell's chat panel this page (HomeChatSlot.vue); a phone, with no panel above its router,
             draws the pane itself on the chat's own surface. Hidden, never unmounted, while a view stands in its place. -->
        <HomeChatSlot
            v-if="conversation && !mobile"
            v-show="!shownView"
            :key="`${sandbox.activeSandboxId.value}:${conversation.conversationId}`"
        />
        <div v-else-if="conversation" v-show="!shownView" class="ground-card flex min-h-0 flex-1 bg-card">
            <ChatPane
                :key="`${sandbox.activeSandboxId.value}:${conversation.conversationId}`"
                :conversation="conversation"
                :focused="true"
                :closable="false"
            />
        </div>
        <!-- Before the waits, as SandboxGate orders them: the hello already named the version and the routes, and an update
             that restarts the sandbox is followed on the update's own page rather than a connecting one. -->
        <div v-else-if="!shownView && daemonTooOld" class="flex min-h-0 flex-1 overflow-auto">
            <SandboxTooOld />
        </div>
        <div v-else-if="!shownView && homeMissing" class="flex flex-1 items-start justify-center p-6" data-home-too-old>
            <div class="flex w-full max-w-md flex-col items-start gap-3">
                <SandboxOutdatedNotice :missing="t(`home.tooOld`)" />
                <Button tier="boring" size="small" :label="t(`chat.homeDoor.openNamed`, { name: sandbox.active.value?.name ?? `` })" @click="enter" />
            </div>
        </div>
        <div v-else-if="!shownView && (!sandbox.reachable.value || warming)" class="flex min-h-0 flex-1 overflow-auto">
            <SandboxWarming v-if="warming" />
            <SandboxConnecting v-else />
        </div>
        <div v-else-if="!shownView" class="flex flex-1 items-start justify-center p-6">
            <div class="max-w-md text-sm text-muted" role="status">
                <p>
                    {{ failure === undefined ? t(`home.loading`) : t(`home.failed`) }}
                    <button v-if="failure !== undefined" type="button" class="ml-3 underline" @click="retry++">{{ t(`home.retry`) }}</button>
                </p>
                <p v-if="failure" class="mt-1 text-xs">{{ failure }}</p>
            </div>
        </div>
    </section>
</template>
