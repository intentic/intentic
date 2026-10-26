<script setup lang="ts">
import { machinesOf } from "@intentic/sandbox-contract/schemas/devices";
import { Button, Notice, RowGroup, RowNote, type Tip } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, watchEffect } from "vue";
import {
    appBehind,
    comparedRouteCount,
    daemonBehind,
    daemonDrifted,
    driftedRoutes,
    driftScope,
    missingRoutes,
    unknownDaemonRoutes,
} from "../../../../client/sandbox/useDaemonRoutes";
import { driftAreas, type DriftGroup, driftGroups, kindTag } from "./driftReport";
import DriftChip from "./DriftChip.vue";
import { contractUncompiled, readContractFreshness, uncompiledRoutes } from "../../../../client/sandbox/contractFreshness";
import { useEnvironment } from "../../../../models/sandbox/environment/useEnvironment";
import RunCommand from "../../../../components/RunCommand.vue";
import { runSeveringDeviceCommand, useDevices, useHostHolding } from "../../../../models/sandbox/devices/useDevices";
import { useOperation } from "../../../../workbench/operations/operations";
import { activeSandboxId } from "../../../../app/storage/activeSandbox";
import { expectRestart } from "../../../../models/sandbox/live/sandboxRestart";
import ConnectDeviceHint from "../../../../parts/sandbox/ConnectDeviceHint.vue";
import { useT } from "@intentic/ui/i18n";

// Checks the daemon's route surface against this app's contract, not version strings (SandboxUpdateCard); catches
// gaps a version compare misses (dev packages are all 0.0.0). A missing route names the daemon as older; a drifted
// payload only proves disagreement, so the heading never guesses. Non-blocking: an old sandbox keeps working.
//
// WHAT IT DRAWS IS ONE SENTENCE AND THEN THE FALLOUT, because "7 routes disagree" named the mechanism and nothing a
// reader could act on. The heading names which side is behind and the sentence under it says why (and, when known,
// which machine the sandbox is on); then one line per kind of gap ("Not available", "May misbehave"), its parts as
// chips (DriftChip). A row per part with a badge each was the version before, and fifteen rows saying "may misbehave"
// fifteen times read as a wall. What a part is, what the gap costs and the dotted route names are a chip's popover.
//
// EVERY SENTENCE HERE IS WRITTEN FOR SOMEONE WHO DID NOT BUILD THIS. No "contract", "route", "call", "daemon",
// "compiled" or "working tree" reaches the screen; those words made the first two versions of this card unreadable.
// And nothing here says RELOAD for what restarts the sandbox: to anyone with a browser open, reload is F5.

const t = useT();

// Dev gets the restart button; a non-dev user is pointed at the update card instead.
const isDev = import.meta.env.DEV;
const { slug, localImage } = useEnvironment();
// A dev sandbox runs the code straight off the checkout, not out of the image: a restart picks a change up, a
// full image rebuild is not needed for one.
const restartCommand = computed(() => `sh _sandbox/sandbox/scripts/dev-restart.sh${slug.value === undefined ? `` : ` ${slug.value}`}`);

// The environment holding this sandbox's checkout, when it is a connected device: then the restart is a button here
// and the command below is only for a checkout nothing can reach. The checkout, not merely the machine — a PC reports
// this container through its Windows side too, and the restart is a `sh` line in a folder only one side has.
const running = useHostHolding(
    () => slug.value,
    () => localImage.value?.root,
);
const { devices } = useDevices({ poll: false });
const onlineDevices = computed(() => devices.value.filter((device) => device.hostId !== undefined && device.online === true));
// dev-restart.sh is a unix line whatever else is true, so a door that runs one itself is the first choice; a Windows
// door is still offered when it is the only one, since the daemon crosses into that PC's distro from there.
const unixDoors = computed(() => onlineDevices.value.filter((device) => device.platform !== `windows`));
// Which machine runs this sandbox is itself read off the daemon's fleet payload, so a daemon far enough behind to
// disagree about that payload answers "none" — and the one button that fixes it would vanish with the field it was
// gated on, exactly when this card is on screen. A single online machine is not a guess, so it is offered: the restart's
// argv names this sandbox's own slug on the far side, so a machine that doesn't hold it refuses rather than restarting
// something else. Two of them is a guess, and stays the printed command; two doors onto one PC (Windows and a distro
// on it) are one machine, and the distro's door is the one that can run the script.
const hostId = computed(
    () => running.value ?? (machinesOf(onlineDevices.value).length === 1 ? (unixDoors.value[0] ?? onlineDevices.value[0])?.hostId : undefined),
);
// The restart is this sandbox's, not this card's: kept in the operations ledger, so a reader who opens another section
// while it runs comes back to it still running (and the button still held), then to how it ended.
const restart = useOperation(`sandbox/dev-restart`);
const restarting = restart.busy;
const restarted = computed(() => restart.operation.value?.state === `done`);
const failed = computed(() => restart.failure.value);
// What the button does, on hover rather than as two lines under it. The note heads off the other button: the Update
// card's "Rebuild from checkout" builds a whole new image and takes minutes, and this gap doesn't need it.
const restartTip = computed<Tip | undefined>(() =>
    hostId.value === undefined || restarting.value || restarted.value
        ? undefined
        : {
              title: t(`sandbox.sandboxBehindCard.restartTipTitle`),
              rows: [
                  { label: t(`sandbox.sandboxBehindCard.restartTipOn`), value: hostId.value },
                  { label: t(`sandbox.sandboxBehindCard.restartTipTakes`), value: t(`sandbox.sandboxBehindCard.restartTipAboutMinute`) },
                  { label: t(`sandbox.sandboxBehindCard.restartTipKeeps`), value: t(`sandbox.sandboxBehindCard.restartTipKeepsWhat`) },
              ],
              note: t(`sandbox.sandboxBehindCard.restartTipNote`),
          },
);
// A refusal (an older container with no checkout recorded, a device with commands switched off) hands the command
// back, since the button has just proved it cannot do this here.
const showCommand = computed(() => hostId.value === undefined || failed.value !== undefined);

const restartOnDevice = async (): Promise<void> => {
    const id = hostId.value;
    const sandbox = activeSandboxId.value;
    if (id === undefined || restarting.value) {
        return;
    }
    const what = t(`sandbox.sandboxBehindCard.restartingTheSandbox`);
    await restart.run({
        what,
        failed: (error) => noticeFrom(error, t(`sandbox.sandboxBehindCard.couldntRestart`), { tone: `warning` }),
        task: async () => {
            // The silence this causes is the restart, said so by every surface rather than read as a fault. Armed for
            // the whole run, since the machine can take the sandbox down before its answer arrives; once the ask went
            // through, the sandbox answering again is what ends it.
            const restartWork =
                sandbox === undefined
                    ? undefined
                    : {
                          sandbox,
                          id: `dev-rebuild` as const,
                          what,
                          quiet: { title: what, detail: t(`sandbox.sandboxBehindCard.restartingOn`, { hostId: id }) },
                      };
            const settle = restartWork === undefined ? undefined : expectRestart(restartWork);
            try {
                // Undefined is the expected ending: the container being restarted is the one answering this request.
                await runSeveringDeviceCommand(id, `dev-restart`);
                if (restartWork !== undefined) {
                    expectRestart({ ...restartWork, untilAnswered: true });
                }
            } finally {
                settle?.();
            }
        },
    });
};

// Asked only once something already disagrees: with the two sides level there is no cause to explain, and the answer
// costs the dev server a contract load.
watchEffect(() => {
    if (daemonBehind.value || daemonDrifted.value) {
        void readContractFreshness();
    }
});

// Each side lacking routes the other has: the two builds forked rather than one trailing the other, so neither "behind"
// nor "out of sync" is true and no single restart is the answer.
const forked = computed(() => daemonBehind.value && appBehind.value);

// Five diagnoses, most specific first. An uncompiled contract explains missing routes and drifted ones alike — the
// compiled copy the sandbox runs simply predates the edit — so it outranks the rest rather than being one more guess
// about which side is older.
const heading = computed(() => {
    if (contractUncompiled.value) {
        return t(`sandbox.sandboxBehindCard.headingUncompiled`);
    }
    if (forked.value) {
        return t(`sandbox.sandboxBehindCard.headingForked`);
    }
    if (daemonBehind.value) {
        return t(`sandbox.sandboxBehindCard.headingBehind`);
    }
    return driftScope.value === `wholesale` ? t(`sandbox.sandboxBehindCard.headingWholesale`) : t(`sandbox.sandboxBehindCard.headingPartial`);
});

// Named as its own clause rather than folded into the heading: a newer sandbox than tab is ordinary, and only worth
// saying once something else has proved the two disagree. Never on a fork, which says it better already. A flag rather
// than a sentence to append: the wholesale cause says it inside its own message, so no language has to be glued.
const leaning = computed(() => appBehind.value && !forked.value && !contractUncompiled.value);

// WHY, in one sentence and no numbers. Partial drift has no cause line: the heading and the chips carry it.
const cause = computed((): string | undefined => {
    if (contractUncompiled.value) {
        return t(`sandbox.sandboxBehindCard.causeUncompiled`);
    }
    if (forked.value) {
        return t(`sandbox.sandboxBehindCard.causeForked`);
    }
    if (daemonBehind.value) {
        return t(`sandbox.sandboxBehindCard.causeBehind`);
    }
    if (driftScope.value === `wholesale`) {
        return leaning.value ? t(`sandbox.sandboxBehindCard.causeWholesaleAppOlder`) : t(`sandbox.sandboxBehindCard.causeWholesale`);
    }
    return leaning.value ? t(`sandbox.sandboxBehindCard.appOlder`) : undefined;
});

// Which machine the sandbox is actually on, said only when this app is sure of it: the fallback `hostId` above is a
// one-device guess, good enough to aim a restart at and not good enough to state as a fact.
const runsOn = computed(() => (running.value === undefined ? undefined : t(`sandbox.sandboxBehindCard.runsOn`, { where: running.value })));

// EVERY AREA AT ONCE IS NOT A LIST, IT IS A WALL. Past the wholesale threshold the drift reaches all forty-odd
// areas of the product, and forty chips indict the whole app for one cause. So the drifted line holds one sentence
// there instead of chips, and the other two kinds keep theirs.
const listed = computed(() => (driftScope.value === `wholesale` ? [] : driftedRoutes.value));
const groups = computed((): readonly (DriftGroup & { readonly note?: string })[] => {
    const found = driftGroups(driftAreas({ missing: missingRoutes.value, drifted: listed.value, extra: unknownDaemonRoutes.value }));
    if (driftScope.value !== `wholesale`) {
        return found;
    }
    // The drifted line keeps its place between the other two, holding the sentence instead of chips.
    const drifted = { kind: `drifted` as const, areas: [], note: t(`sandbox.sandboxBehindCard.wholesaleNote`) };
    return [...found.filter((group) => group.kind === `missing`), drifted, ...found.filter((group) => group.kind === `extra`)];
});

// The bottom block holds only what is there to say: a restart in flight or done, a refusal, the printed command, the
// offer to connect, or (outside dev) where the fix lives.
const restartStatus = computed(() => hostId.value !== undefined && (restarted.value || restarting.value));
const hasFooter = computed(() => !isDev || restartStatus.value || failed.value !== undefined || showCommand.value);
</script>

<template>
    <RowGroup v-if="daemonBehind || daemonDrifted" :label="heading">
        <!-- RESTART, NEVER "RELOAD": this rebuilds and restarts the whole sandbox out there. Top right, where the fix
             for the whole group belongs, rather than under a list the reader has to get past first. -->
        <template v-if="isDev && hostId" #actions>
            <Button
                tier="accent"
                :label="restarting ? t(`sandbox.sandboxBehindCard.restarting`) : t(`sandbox.sandboxBehindCard.restartSandbox`)"
                size="small"
                v-tooltip.top="restartTip"
                :loading="restarting"
                @click="void restartOnDevice()"
            >
                <template #icon><Icon name="refresh" /></template>
            </Button>
        </template>

        <!-- The cause, before any list: a reader who misreads why is going to misread every chip under it. -->
        <RowNote v-if="cause !== undefined || runsOn !== undefined" icon="exclamation-triangle" tone="warning">
            {{ [cause, runsOn].filter((part) => part !== undefined).join(` `) }}
        </RowNote>

        <!-- One line per kind of gap, its parts as chips: the kind is said once, not once per part. -->
        <RowNote v-for="group in groups" :key="group.kind" variant="block">
            <div class="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:gap-3">
                <span class="shrink-0 text-xs text-muted sm:w-28">{{ kindTag(group.kind) }}</span>
                <span v-if="group.note !== undefined" class="text-xs">{{ group.note }}</span>
                <div v-else class="flex flex-wrap gap-1.5">
                    <DriftChip v-for="area in group.areas" :key="area.key" :area="area" />
                </div>
            </div>
        </RowNote>

        <RowNote v-if="hasFooter" variant="block">
            <div v-if="isDev" class="flex flex-col gap-2">
                <!-- Only while it's happening or done: what the button does, before it's pressed, lives in its hover card. -->
                <p v-if="restartStatus" class="text-2xs text-subtle">
                    <template v-if="restarted">{{ t(`sandbox.sandboxBehindCard.rebuiltOnReloadPage`, { hostId }) }}</template>
                    <template v-else>{{ t(`sandbox.sandboxBehindCard.restartingOn`, { hostId }) }}</template>
                </p>
                <Notice v-if="failed" :of="failed" class="text-2xs" />
                <RunCommand
                    v-if="showCommand"
                    :command="restartCommand"
                    :explanation="daemonDrifted && !failed ? t(`sandbox.sandboxBehindCard.stillHereRun`) : t(`sandbox.sandboxBehindCard.run`)"
                    :label="t(`sandbox.sandboxBehindCard.restartCommand`)"
                />
                <!-- Only where the button never had a chance: a refusal means the door is open and something else went wrong, which connecting a second time would not fix. -->
                <ConnectDeviceHint v-if="!hostId" :slug="slug" :gains="t(`sandbox.sandboxBehindCard.restartBecomesButton`)" />
            </div>
            <p v-else-if="daemonDrifted" class="text-2xs text-subtle">{{ t(`sandbox.sandboxBehindCard.staysUpdateSandboxImage`) }}</p>
            <p v-else class="text-2xs text-subtle">{{ t(`sandbox.sandboxBehindCard.updateSandboxImage`) }}</p>
        </RowNote>
    </RowGroup>
</template>
