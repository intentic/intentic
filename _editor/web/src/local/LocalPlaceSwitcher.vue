<script setup lang="ts">
import { AnchoredOverlay, Notice, SandboxLogo, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { localFace } from "../app/environments/local";
import { type LocalFacts, type LocalSandbox, localHost } from "../app/environments/localHost";
import { placementOfKind } from "../features/sandbox/overview/placement";
import { formatChord, isApplePlatform } from "../shell/commands/keybindings";
import { sandboxSlot, sandboxSlotChord } from "./localKeys";

// THE PLACE CHIP: the top of a local window's rail, where the sandbox shell keeps its sandbox switcher, and the same
// control. The chip says which folder of this computer the window shows; its menu lists the account's sandboxes, the
// only other places this window can go, as the workspace's switcher lists This computer as the only place it can go.
// A sandbox opens the workspace on it, which in the main window takes this window's place.
//
// The sandboxes are the ones the workspace last told the app about (localHost.ts `roster`): this page cannot ask
// the platform. So a row carries what came with it (a name, where it runs, whether it is shared) and no count or state,
// which would be as old as the workspace's last look. Until the workspace has said, the row is the workspace itself.

const t = useT();
const host = localHost();
const face = localFace();

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

// The main window is the one the workspace swaps in for; from any other, a sandbox opens in that window, not this one.
const inMainWindow = face?.home === true;

// The window's folder, as the chip names it. A document opened on its own names its folder too: the chip is about the
// place, the tab row about the document.
const name = computed(() => face?.name ?? t(`shared.files`));
const chipTip = computed((): Tip => ({ title: name.value, note: face?.path ?? `` }));

// Read each time the chip opens. Only the newest read writes, so one answering late cannot put back a list the reader
// has since changed.
const facts = ref<LocalFacts | undefined>(undefined);
const sandboxes = ref<readonly LocalSandbox[]>([]);
let reads = 0;
const reload = async (): Promise<void> => {
    reads += 1;
    const read = reads;
    try {
        const [known, roster] = await Promise.all([host.facts(), host.roster()]);
        if (read === reads) {
            facts.value = known;
            sandboxes.value = roster.sandboxes;
        }
    } catch (error) {
        console.error(`[local] the sandboxes could not be read:`, error);
    }
};
watch(open, (isOpen) => {
    if (isOpen) {
        failure.value = undefined;
        void reload();
    }
});

// What went wrong, beside the row it is about: the app's own sentence (local.rs), already written for the reader.
const failure = ref<{ readonly key: string; readonly message: string } | undefined>(undefined);
const working = ref<string | undefined>(undefined);
const attempt = async (key: string, act: () => Promise<void>): Promise<void> => {
    if (working.value !== undefined) {
        return;
    }
    failure.value = undefined;
    working.value = key;
    try {
        await act();
        open.value = false;
    } catch (error) {
        failure.value = { key, message: error instanceof Error ? error.message : String(error) };
    } finally {
        working.value = undefined;
    }
};

// The way to agents, as the rail's foot offers it too: the workspace once this install has an account, else a sign-in.
const toAgents = (): void => void attempt(`:agents`, () => (facts.value?.accountSeen === true ? host.openWorkspace() : host.signIn()));

// A sandbox is the workspace opened on it (router/sandboxArrival.ts), which says so when the account no longer lists it.
const sandboxKey = (box: LocalSandbox): string => `sandbox:${box.id}`;
const pickSandbox = (box: LocalSandbox): void =>
    void attempt(sandboxKey(box), () => host.openWorkspace(`/?${new URLSearchParams({ sandbox: box.id }).toString()}`));
const addSandbox = (): void => void attempt(`:add`, () => host.openWorkspace(`/setup`));

// Alt+1…9 from anywhere in the window, as in the workspace: the list is read fresh, so the digit names the sandbox the
// workspace last listed in that place even while this menu has never been opened.
const isMac = isApplePlatform();
const slotLabel = (at: number): string | undefined => {
    const chord = sandboxSlotChord(at);
    return chord === undefined ? undefined : formatChord(chord, isMac);
};
const pickSlot = async (at: number): Promise<void> => {
    try {
        sandboxes.value = (await host.roster()).sandboxes;
    } catch (error) {
        console.error(`[local] the sandboxes could not be read:`, error);
        return;
    }
    const box = sandboxes.value[at];
    if (box !== undefined) {
        pickSandbox(box);
    }
};
const onKeydown = (event: KeyboardEvent): void => {
    const at = sandboxSlot(event, isMac);
    if (at === undefined) {
        return;
    }
    event.preventDefault();
    void pickSlot(at);
};
onMounted(() => window.addEventListener(`keydown`, onKeydown));
onUnmounted(() => window.removeEventListener(`keydown`, onKeydown));

const rowClass = `group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5`;
const failedAt = (...keys: readonly string[]): string | undefined => (failure.value !== undefined && keys.includes(failure.value.key) ? failure.value.message : undefined);
// The workspace's failure, said under the sandboxes it is about.
const agentsFailure = computed(() => failedAt(`:agents`, `:add`));
</script>

<template>
    <!-- The rail's top control, the sandbox switcher's size and shape: the folder's letter, marked as a place on this computer. -->
    <span class="relative flex">
        <button
            ref="trigger"
            type="button"
            class="icon-rail-tile flex items-center justify-center overflow-hidden rounded-lg transition-opacity hover:opacity-80"
            :aria-label="t(`local.placeSwitcher.switchPlace`, { name })"
            :aria-expanded="open"
            v-tooltip.right="open ? undefined : chipTip"
            @click="open = !open"
        >
            <SandboxLogo :name="name" />
        </button>
        <span
            class="icon-rail-mark pointer-events-none absolute bottom-0.5 right-0.5 inline-flex h-[1.6em] w-[1.6em] items-center justify-center rounded-full bg-[color:var(--ui-tile-ground)] leading-none text-subtle"
            aria-hidden="true"
        >
            <Icon name="desktop" class="text-[0.9em]" />
        </span>
    </span>

    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="start" menu>
        <div class="flex w-72 flex-col gap-0.5 p-1">
            <!-- The account's sandboxes, where agents work, each opening the workspace on itself. -->
            <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">{{ t(`shared.sandboxes`) }}</div>
            <template v-if="facts?.accountSeen === true">
                <template v-for="(box, at) in sandboxes" :key="box.id">
                    <button type="button" :class="rowClass" @click="pickSandbox(box)">
                        <span v-if="working === sandboxKey(box)" class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                            <Icon name="spinner" spin class="text-xs" />
                        </span>
                        <SandboxLogo v-else :size="20" :name="box.name" />
                        <span class="min-w-0 flex-1 truncate text-content">{{ box.name }}</span>
                        <!-- Where it runs, as the workspace's switcher marks the same row: dropped where the Shared pill already says it. -->
                        <Icon
                            v-if="!box.shared || placementOfKind(box.place).kind !== `shared`"
                            :name="placementOfKind(box.place).icon"
                            class="shrink-0 text-2xs text-subtle"
                            v-tooltip.top="placementOfKind(box.place).tip"
                            :aria-label="placementOfKind(box.place).detail"
                        />
                        <span v-if="box.shared" class="ui-status-pill shrink-0 bg-content/10 text-2xs font-medium text-subtle">{{ t(`shared.shared`) }}</span>
                        <!-- The same chord as the workspace's row for this sandbox, the only place it can be learned here. -->
                        <kbd v-if="slotLabel(at)" class="shrink-0 rounded border border-line px-1 font-mono text-2xs font-normal leading-4 text-subtle">{{
                            slotLabel(at)
                        }}</kbd>
                        <!-- Only where the workspace opens in another window: from the main one it takes this one's place. -->
                        <Icon v-if="!inMainWindow" name="arrow-up-right" class="shrink-0 text-2xs text-subtle" />
                    </button>
                    <div v-if="failedAt(sandboxKey(box)) !== undefined" class="px-2 pb-1">
                        <Notice tone="danger" class="text-2xs">{{ failedAt(sandboxKey(box)) }}</Notice>
                    </div>
                </template>
                <!-- The workspace has not told the app its sandboxes yet (an install updated since it was last open): the workspace itself, which knows them. -->
                <button v-if="sandboxes.length === 0" type="button" :class="rowClass" @click="toAgents">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                        <Icon :name="working === `:agents` ? `spinner` : `robot`" :spin="working === `:agents`" class="text-sm" />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-content">{{ t(`local.placeSwitcher.workspace`) }}</span>
                        <span class="truncate text-2xs text-subtle">{{ t(`local.placeSwitcher.workspaceLead`) }}</span>
                    </span>
                    <Icon name="arrow-up-right" class="shrink-0 text-2xs text-subtle" />
                </button>
                <button type="button" :class="rowClass" @click="addSandbox">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                        <Icon :name="working === `:add` ? `spinner` : `plus`" :spin="working === `:add`" class="text-sm" />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-content">{{ t(`sandbox.words.addSandbox`) }}</span>
                </button>
            </template>
            <!-- No account on this install yet: what agents need, and the sign-in that brings the workspace. -->
            <button v-else type="button" :class="rowClass" @click="toAgents">
                <span class="flex h-5 w-5 shrink-0 items-center justify-center text-muted">
                    <Icon :name="working === `:agents` ? `spinner` : `robot`" :spin="working === `:agents`" class="text-sm" />
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-content">{{ t(`local.placeSwitcher.putAgentsToWork`) }}</span>
                    <span class="truncate text-2xs text-subtle">{{ t(`local.placeSwitcher.signInLead`) }}</span>
                </span>
                <Icon name="sign-in" class="shrink-0 text-2xs text-subtle" />
            </button>
            <div v-if="agentsFailure !== undefined" class="px-2 pb-1">
                <Notice tone="danger" class="text-2xs">{{ agentsFailure }}</Notice>
            </div>
        </div>
    </AnchoredOverlay>
</template>
