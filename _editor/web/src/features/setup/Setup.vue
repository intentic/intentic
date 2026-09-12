<script setup lang="ts">
import type { AddressOffer, HostedOffer, SandboxSummary, SetupCode, SetupReport, HostedStatus } from "@intentic/api-contract";
import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { sandboxSubdomain, syncFolder } from "@intentic/sandbox-contract";
import {
    Button,
    ui,
    Code,
    commandLang,
    CopyButton,
    InfoHint,
    Notice,
    type NoticeModel,
    SegmentedControl,
    StepSection,
    useDevice,
    useOsPreference,
    vAction,
} from "@intentic/ui";
import { noticeFrom, noticeOf, useNow } from "@intentic/ui/async";
import Checkbox from "primevue/checkbox";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { revealConversation } from "../agents/fleet/agentActions";
import { track } from "../../app/analytics";
import { composingConversation } from "../chat/panel/useChat-reveal";
import { apiClient } from "../../lib/useApi";
import { useAuth } from "../auth/useAuth";
import { useGoogleIdentity } from "../auth/useGoogleIdentity";
import CloudflareTokenField from "../capabilities/connect/CloudflareTokenField.vue";
import { useCloudflareZones } from "../extensions/useCloudflareZones";
import { sandboxIdFromToken } from "../sandbox/client/sandboxIdFromToken";
import { useSandbox } from "../sandbox/client/useSandbox";
import { desktopInstaller, desktopSetupLink, desktopVersion, openDesktopLink } from "../../app/environments/desktop";
import { environment } from "../../app/environments/environment";
import { bashCommand, psCommand, scriptSource } from "../../app/environments/scriptCommand";
import DesktopSetupProgress from "./DesktopSetupProgress.vue";
import { useDesktopSetup } from "./desktopSetup";
import SetupCompose from "./SetupCompose.vue";
import SetupHandoff from "./SetupHandoff.vue";
import SetupNudge from "./SetupNudge.vue";
import SetupRunDetails from "./SetupRunDetails.vue";
import SetupRungArt from "./SetupRungArt.vue";
import SetupSyncOption from "./SetupSyncOption.vue";
import { arrivalFor, type Arrival } from "./setupArrival";
import { lanesFor, type OfferRead } from "./setupLanes";
import type { ComposeArgs } from "./setupCompose";
import { type AttachOutcome, daemonUrlProblem, normalizeDaemonUrl, probeDaemon } from "./setupAttach";
import { autoSandboxName } from "./setupName";
import { setupReportView } from "./setupReport";
import { hostedWaitView } from "./hostedWait";
import AppBrand from "../../components/AppBrand.vue";
import { useSiteFaces } from "../../shell/useSiteFaces";

// No identity or machine decision here: the surface (setupArrival.ts) decides those; this page is what's left
// otherwise.
// Two lanes share the same `created` row: provision mints a tunnel and a setup code the command redeems; attach records
// an
// already-reachable domain directly, skipping step 2.

const sandbox = useSandbox();
const router = useRouter();
const route = useRoute();
// Phone gets a different step 2 (handoff, not narrower): the command hides behind `commandVisible`.
const { mobile } = useDevice();
const { user } = useAuth();

// Shares `/login`'s visual material (`styles/entry.css`) rather than duplicating it.
useSiteFaces();
const { getIdToken, warmIdToken } = useGoogleIdentity();

// Sandbox this page is setting up; null while auto-create is in flight or after it failed.
const created = ref<SandboxSummary | null>(null);
// True when we arrived via ?sandbox=<id> and resumed an existing sandbox (vs. created one here now).
const resuming = ref(false);
// Row minted by this visit is a discardable draft; a resumed row is someone's unfinished errand.
const createdHere = ref(false);
// Setup ran to the end; set explicitly since `created.lastSeenAt` may still be stale on exit.
const finished = ref(false);
const creating = ref(false);
const error = ref<NoticeModel | null>(null);
// Whether the arrival read has answered; without it the first frame reads as a failed create.
const loaded = ref(false);

// Another sandbox to go back to, excluding this one and any that has never reported in.
const otherWorkspace = computed(() => sandbox.sandboxes.value.some((entry) => entry.id !== created.value?.id && entry.lastSeenAt !== null));

// Reachability mode: `intentic` is zero-config; `own` is bring-your-own-Cloudflare.
const mode = ref<"intentic" | "own">(`intentic`);
// Undefined until arrival answers; unknown draws no rung, so nothing has to be retracted once it does.
const intenticAvailable = ref<boolean | undefined>(undefined);
// Platform mints addresses: the answer is in and it's yes; lanes needing one gate on this.
const addressed = computed(() => intenticAvailable.value === true);
// Answer is in and it's no; distinct from not-yet, which is a wait rather than a fact to state.
const addressless = computed(() => intenticAvailable.value === false);

// Three-valued: said-no and never-answered differ. Starts `unreachable`, true before calls land.
const addressRead = ref<OfferRead<boolean>>({ kind: `unreachable` });
const hostedRead = ref<OfferRead<{ enabled: boolean; remaining: number }>>({ kind: `unreachable` });

// Setup code state (both paths): the minted {code, hostname, expiresAt}; the command carries only the code.
const setup = ref<SetupCode | null>(null);
const setupError = ref<NoticeModel | undefined>(undefined);
// The target key `setup` was minted for, so watcher re-fires don't re-mint and a stale mint is discarded.
const mintedFor = ref<string | undefined>(undefined);
let mintTimer: ReturnType<typeof setTimeout> | undefined;

// Own-Cloudflare state: token/zone discovery shared with useCloudflareZones; feeds only the command, never .env.
const cf = useCloudflareZones();
const { cfToken, cfTokenValid, selectedZone, zonesLoading, zonesError } = cf;
// Editable subdomain prefix, pre-filled with the derived `sandbox-<hash>`; hostname is `<subdomain>.<zone>`.
const subdomain = ref(``);
const derivedPrefix = ref(``);
const subdomainValid = computed(() => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(subdomain.value.trim()));

// Desktop sync (on by default): folder rides the command as SYNC_DIR; empty until the mint lands.
const syncEnabled = ref(true);
const syncDir = computed(() => (created.value && setup.value ? syncFolder(created.value.name, setup.value.hostname) : ``));

// Which spine step 1 heads: `provision` (run, wait) or `attach` (a reachable domain); both share `created`.
const lane = ref<"provision" | "attach">(`provision`);
// One disclosure for both ways off the default address: a Cloudflare zone, or an already-answering domain.
const reaching = ref(false);
const domain = ref(``);
// Connection token, revealed after a `needs-token` probe; used once for first-bind, never persisted.
const attachToken = ref(``);
const attaching = ref(false);
const attachOutcome = ref<AttachOutcome | undefined>(undefined);

const normalizedDomain = computed(() => normalizeDaemonUrl(domain.value));
const domainProblem = computed(() => daemonUrlProblem(domain.value));

// Distinguishes reconnecting a sandbox that has run before from resuming one that never started.
const neverStarted = computed(() => created.value !== null && created.value.lastSeenAt === null);

// Step 2 shows one command at a time; the preferred OS is a persisted singleton shared across screens.
const { cmdOs } = useOsPreference();

// Third Run tab (compose) is local state; choosing it must not overwrite the unix/windows pick.
const composeSelected = ref(false);
const runTab = computed<`unix` | `windows` | `compose`>({
    get: () => (composeSelected.value ? `compose` : cmdOs.value),
    set: (value) => {
        composeSelected.value = value === `compose`;
        if (value !== `compose`) {
            cmdOs.value = value;
        }
    },
});
// Labels shed a qualifier on phone; Compose's own label lives in the panel's first line, not the tab.
const runTabOptions = computed(() => [
    { label: `Linux / macOS`, value: `unix` as const },
    { label: mobile.value ? `Windows` : `Windows (PowerShell)`, value: `windows` as const },
    {
        label: mobile.value ? `Compose` : `Docker Compose`,
        value: `compose` as const,
        title: `No script runs: read the whole file, then start it yourself`,
    },
]);

// Drops `sudo` when the machine already has Docker; not persisted, since it's a claim about the paste target.
const hasDocker = ref(false);

// True in the app: same code, same script; step 2 is one button, command controls apply only when visible.
const desktop = computed(() => desktopVersion() !== undefined);

// Installer replaces the raw pipe by default where we ship a build; undefined with no build, so the pipe stays.
const installer = computed(() => (desktop.value || mobile.value ? undefined : desktopInstaller()));
const appFirst = computed(() => installer.value !== undefined);

// Command folds away wherever it isn't the path: the app's button, the phone's handoff, or an offered installer.
const showCommand = ref(false);
const commandVisible = computed(() => (desktop.value || mobile.value || appFirst.value ? showCommand.value : true));
// Compose declares its own env; only the compose tab being shown (not merely no command) hides the sync option.
const composeShown = computed(() => commandVisible.value && runTab.value === `compose`);
// Which machine runs step 2 (`hosted` vs. the user's own); set by arrival, not the reader, save for the picker.
const machine = ref<"hosted" | "mine">(`mine`);

// What the arrival decided; `choose` until the offers and row land, so nothing folds on an unanswered read.
const arrival = ref<Arrival>(`choose`);

// Rungs the arrival didn't take are folded, not absent; `elsewhere` (query or link) reveals them when needed.
const elsewhere = ref(route.query[`elsewhere`] === `1`);
// The picker is on screen when the arrival could answer nothing for itself, or when the reader asked for it.
const elsewhereOffered = computed(() => arrival.value === `choose` || elsewhere.value);

// Reveal link sits under the card while the rungs appear above; scrolls there so the click isn't off-screen.
const ladderRow = ref<HTMLElement | null>(null);
const showOtherMachines = async (): Promise<void> => {
    elsewhere.value = true;
    await nextTick();
    ladderRow.value?.scrollIntoView({ behavior: `smooth`, block: `center` });
};
// Command redeems a setup code; gated on the address offer even in the app, where the button is the command.
const commandOffered = computed(() => addressed.value);

// Hosted lane: a lane moves a machine onto the existing row, never deletes or recreates the sandbox.
// The platform's offer, read on arrival. Null until answered; a platform without the route reads as disabled.
const hostedOffer = ref<HostedOffer | null>(null);
// Whether the platform hosts; independent of whether the picker currently draws the rung.
const hostedOffered = computed(() => hostedOffer.value?.enabled === true);
// Whether a provision lane exists (machine or address); without either, attach is the whole flow, not a detour.
const provisionOffered = computed(() => addressed.value || hostedOffered.value);
// Provisioning/releasing a machine is a round-trip with a provider; the card says so rather than freezing.
const hostedBusy = ref(false);
const releasingHosted = ref(false);
const releaseRequested = ref(false);
const hostedRequested = ref(false);
let hostedAction = 0;
// Why the hosted lane failed, shown on the step where it was clicked; kept separate from the arrival `error`.
const hostedError = ref<NoticeModel | undefined>(undefined);
// Created row is a hosted one; the wait card renders off this, not the picker, so a resumed row narrates right.
const hostedRow = computed(() => created.value?.hosted ?? null);
// Account's hosted allowance is already spent on a different sandbox; the card still renders, explaining why.
const hostedSpent = computed(() => hostedOffered.value && (hostedOffer.value?.remaining ?? 0) === 0 && hostedRow.value === null);
// A refusal for room already met by this browser, harder than a later count; cleared only by `recheckCapacity`.
const hostedRefusedForRoom = ref(false);
// Platform out of machines (distinct from `hostedSpent`); gates only starting new, not an existing row.
const hostedFull = computed(
    () => hostedOffered.value && (hostedOffer.value?.full === true || hostedRefusedForRoom.value) && hostedRow.value === null,
);
// Provision spine offer, from setupLanes.ts; `lane` is written only by `setLane`, never switched automatically.
const lanes = computed(() => lanesFor({ address: addressRead.value, hosted: hostedRead.value, hasMachine: hostedRow.value !== null }));
// Whether there's a lane to take, worth drawing the ladder for; otherwise a card just explains itself.
const laneTakeable = computed(() => lanes.value.kind === `takeable`);
// Free lane's hour budget, or null where it doesn't apply; null means the cards say nothing about hours at all.
const hostedHours = computed(() => hostedOffer.value?.hours ?? null);
// The daemon's announced host, once it exists: step 1's address line for a lane that never mints a code.
const hostedHost = computed(() => {
    const url = created.value?.daemonUrl;
    if (url === null || url === undefined) {
        return undefined;
    }
    try {
        return new URL(url).host;
    } catch {
        return undefined;
    }
});
// When the hosted wait began; only escalates a wait already progressing, never the source of what the card says.
const hostedSince = ref<number | undefined>(undefined);
// Machine power state, polled only while somebody waits; undefined or failed degrades to a plain spinner.
const hostedMachine = ref<HostedStatus[`machine`] | undefined>(undefined);
// Machine state is a rate-limited provider call; polled once every this many (cheap) registry polls instead.
const MACHINE_EVERY = 4;
let machineTick = 0;
// Boot report and any refused check-in, from the poll; null until either happens, as on any older sandbox.
const bootReport = ref<SandboxSummary[`bootReport`]>(null);
const announceRefusal = ref<SandboxSummary[`announceRefusal`]>(null);
// Whether the daemon has ever checked in. Read off the poll rather than off `created` for the same reason.
const announced = ref(false);
// Two-rung picker (hosted vs. own hardware), each with one caption, no nested chrome around it. A third rung (a
// bespoke cloud VM) existed and was removed as redundant.
// One card per rung, not a pill with caption: cost and what it asks must be visible before clicking, not skimmed
// after. `meta` is the badge, `note` the words under it.
// `value` doubles as the drawing's name (SetupRungArt), so rung and picture can't drift; no separate `icon`.
interface MachineOption {
    readonly value: "hosted" | "mine";
    readonly title: string;
    readonly meta: string;
    readonly note: string;
}
const ladderOptions = computed<readonly MachineOption[]>(() => [
    ...(hostedOffered.value
        ? [
              {
                  value: `hosted` as const,
                  // Title answers 'what do I do', not 'whose machine'; that fact lives in `note` instead.
                  title: `Start instantly`,
                  // Badge carries the hour ceiling, never bare 'Free', and what happens after: unlimited reads 'always
                  // on'.
                  // When the fleet is full, the badge says so instead of a price; the rung stays on screen, not hidden.
                  meta: hostedFull.value
                      ? `No machines free right now`
                      : hostedOffer.value?.plan
                        ? `On your plan · always on`
                        : hostedHours.value === null
                          ? `Free · ready in seconds`
                          : `Free to try · ${hostedHours.value.allowance}h a month, always on with the plan`,
                  note: `Runs on our servers`,
              },
          ]
        : []),
    // Reader's own machine says no more than its three lines; there's nothing more the badge doesn't say.
    ...(commandOffered.value
        ? [
              {
                  value: `mine` as const,
                  title: `My own computer`,
                  meta: `Most power · no limits`,
                  // Note names the actual next step; reads off the same `installer` the step below uses, so they can't
                  // disagree.
                  note: installer.value === undefined ? `One pasted command` : `A ${installer.value.label} installer`,
              },
          ]
        : []),
]);
// Shown only with a real choice; one rung isn't a picker, and an unread offer has nothing honest to draw.
const ladderShown = computed(() => elsewhereOffered.value && ladderOptions.value.length > 1);
// Reverse of `ladderShown`: the untaken rung folds behind a link, off the same facts, never an empty promise.
const otherMachinesFolded = computed(() => !elsewhereOffered.value && ladderOptions.value.length > 1);

// Rung requested via `?machine=` before this page; validated against `ladderOptions` so an unoffered rung falls
// back to default. Read once on arrival, never watched.
const requestedMachine = (): MachineOption[`value`] | undefined => {
    const asked = route.query[`machine`];
    return ladderOptions.value.find((option) => option.value === asked)?.value;
};

// Which address the card reports: hosted's own, none minted, the intentic default, or the reader's own zone.
const addressFact = computed<`hosted` | `none` | `intentic` | `own`>(() =>
    machine.value === `hosted` ? `hosted` : addressless.value ? `none` : mode.value === `intentic` ? `intentic` : `own`,
);

// Quiet label on the address row; styled as a band opener, not body copy, so it isn't read as a sentence.
const factLabel = `fact-label shrink-0`;

// Baseline-aligned, not box-centred, so label/value share a line; mono only for a real hostname, not a sentence.
const factSlot = `flex min-w-0 items-baseline text-sm text-content`;
const factHost = `${factSlot} fact-host font-mono`;

// Mint dedupe/stale-response key: sandbox id (so switching sandboxes invalidates a stale mint) plus lane (mint
// buys the intentic tunnel, which attach doesn't use). Sync choice isn't part of it; it rides the command, not
// the code.
const targetKey = computed<string | undefined>(() => {
    // Hosted lane never mints: its machine already holds the tunnel, so a code would buy a command nothing runs.
    if (created.value === null || lane.value === `attach` || machine.value === `hosted` || hostedRow.value !== null || releasingHosted.value) {
        return undefined;
    }
    // Nor a platform with no addresses to mint, either mode: the gate is server-side, so asking anyway just spins.
    if (!addressed.value) {
        return undefined;
    }
    return `${created.value.id}:${created.value.token}`;
});

// The command can be built only once the chosen target has a code minted for it.
const commandReady = computed(() => setup.value !== null && mintedFor.value === targetKey.value);
// Sync exists only where the command does: not pre-mint, not on compose, not for hosted; survives the app fold.
const syncOffered = computed(() => commandReady.value && !composeShown.value && (commandVisible.value || desktop.value));
// `.title` rather than the NoticeModel itself: interpolated whole, it renders as its own JSON.
const lockedReason = computed(() => {
    // Not a wait: no command is coming, so this states the fact rather than saying 'Preparing…', which read as hung.
    if (addressless.value) {
        return `This platform doesn't hand out addresses, so there's no install command to run. Connect a sandbox you're already running instead.`;
    }
    if (mode.value === `intentic`) {
        return setupError.value?.title ?? `Preparing your intentic domain…`;
    }
    if (cfToken.value.length === 0) {
        return `Enter your Cloudflare API token to reveal your install command.`;
    }
    if (!cfTokenValid.value) {
        return `Your install command appears once the token above looks valid.`;
    }
    if (zonesLoading.value) {
        return `Checking which Cloudflare zones this token can use…`;
    }
    if (zonesError.value !== undefined) {
        return `Fix the Cloudflare token issue above to continue.`;
    }
    if (selectedZone.value === undefined) {
        return `Choose which Cloudflare zone to use to reveal your command.`;
    }
    if (!subdomainValid.value) {
        return `Enter a valid subdomain (letters, numbers, hyphens) to reveal your command.`;
    }
    return setupError.value?.title ?? `Preparing your install command…`;
});

// Handoff step 2 goes through, in order:
//   `locked` : no command yet (lockedReason says what's missing)
//   `yours` : command shown, nothing in flight yet
//   `handed` : copied (or app-launched); waiting on the user's machine
//   `claimed`: a machine redeemed the code at /setup/claim; the wait is earned
type Handoff = "locked" | "yours" | "handed" | "claimed";

// Command was copied; page-level and persistent, unlike CopyButton's 1.5s flash: the hinge the card turns on.
const copied = ref(false);
// App was handed the code (desktop's copy-equivalent); last thing observable before the machine takes over.
const launched = ref(false);
/* …and what the app says about that setup afterwards (desktopSetup.ts): the bar its own card draws, reported
 * here on every change, so the page a dismissed card hands the window back to can show how the install is
 * going rather than pointing at a window that has just stepped aside. */
const { report: desktopReport, heardAt: desktopHeardAt } = useDesktopSetup();
// A link back to this screen is in the user's inbox (the phone's handoff: SetupHandoff.vue). Deliberately NOT
// part of `handoff` below: that state machine tracks the COMMAND's journey to a machine, and posting yourself a
// bookmark does not advance it by a step. What it does change is what the stuck-wait nudge should say, because
// for this user the next move is on a laptop that hasn't been opened yet rather than in a terminal.
const emailed = ref(false);
// Server-side proof the command ran; cleared each mint, so a value here always describes the command on screen.
const claimedAt = ref<string | null>(null);
// Machine's account of the run, staged with fixes on failure; cleared each mint like the claim stamp.
const report = ref<SetupReport | null>(null);
// From setupReport.ts: `failures` is the verbatim what-broke list, `stage` the healthy run's live footer line.
const reportFailures = computed(() => setupReportView(report.value).failures);
const buildStage = computed(() => setupReportView(report.value).stage);

// Command exists and the registry is watched; gated on `commandReady` so a stale re-mint narrates nothing.
const waiting = computed(() => commandReady.value);
const handoff = computed<Handoff>(() => {
    if (!commandReady.value) {
        return `locked`;
    }
    // Report is proof like the claim stamp, and can arrive first (a preflight failure before redemption).
    if (claimedAt.value !== null || report.value !== null) {
        return `claimed`;
    }
    return copied.value || launched.value ? `handed` : `yours`;
});

// When the command became runnable; resets on re-mint, since only elapsed time triggers a silent failure.
const armedAt = ref<number | undefined>(undefined);
// Last visible reader action (e.g. a download click); the right clock once armedAt has gone stale.
const actedAt = ref<number | undefined>(undefined);
// One wall clock, armed only while a command or hosted wait is on screen, so an unarmed step 2 costs no tick.
const now = useNow(() => armedAt.value !== undefined || hostedSince.value !== undefined);
watch(commandReady, (ready) => {
    armedAt.value = ready ? Date.now() : undefined;
});

// Hosted wait from three sources (hostedWait.ts); reads the clock only to escalate, never to decide the wording.
const hostedWait = computed(() =>
    hostedWaitView({
        machine: hostedMachine.value,
        boot: bootReport.value,
        refusal: announceRefusal.value,
        announced: announced.value,
        // Machine origin from the row's hosted stamp; decides which of the two boot-time promises the card makes.
        warm: hostedRow.value?.warm,
        waitedMs: hostedSince.value === undefined ? 0 : now.value - hostedSince.value,
    }),
);

// Long fuse for compose, phone, and own-computer-via-app; drops to the short fuse once the command is unfolded.
const installing = computed(() => appFirst.value && !commandVisible.value);
// Installer was fetched (not proof of install, just intent); changes both when the nudge fires and what it says.
const downloaded = ref(false);
const onDownload = (): void => {
    downloaded.value = true;
    actedAt.value = Date.now();
    track(`desktop_installer_downloaded`, { platform: installer.value?.platform ?? `unknown` });
};
const nudgeAfterMs = computed(() => (composeShown.value || mobile.value || installing.value ? 3 * 60_000 : 40_000));
// When it stops assuming the command was never run, and starts helping a terminal that errored instead.
const STALLED_MS = 3 * 60_000;
// Claimed but no daemon yet: the first image pull is slow, so this waits longer before suggesting a problem.
const SLOW_BUILD_MS = 6 * 60_000;

const waitedFrom = computed(() =>
    actedAt.value !== undefined && armedAt.value !== undefined ? Math.max(actedAt.value, armedAt.value) : armedAt.value,
);
const waitedMs = computed(() => (waitedFrom.value === undefined ? 0 : now.value - waitedFrom.value));
// Every fuse below is a GUESS from elapsed time, and a machine report makes guessing obsolete: a failure
// card names the real problem (nudging beside it would say "you haven't run it" about a command that
// demonstrably ran and died), and live stage narration IS the answer slowBuild's "check that terminal" was
// groping for. The fuses stay for machines running an ic too old to report.
// …and never over a live report from the app: "still nothing" beside a bar that is visibly moving would be the
// page contradicting the app it handed the work to.
const nudging = computed(() => handoff.value !== `claimed` && waitedMs.value > nudgeAfterMs.value && desktopReport.value === undefined);
const stalled = computed(() => handoff.value !== `claimed` && waitedMs.value > STALLED_MS);
// Which reader the correction addresses (SetupNudge renders it); decided here, where the relevant state lives.
const nudgeVariant = computed(() => {
    if (mobile.value && emailed.value) {
        return `emailed` as const;
    }
    if (commandVisible.value) {
        return `terminal` as const;
    }
    // Browser offered an installer: nothing was meant to be pasted, and the app's own button doesn't exist here yet.
    if (installing.value) {
        // Once downloaded, the correction must move on too, or it reads as not noticing the reader's own action.
        return downloaded.value ? (`downloaded` as const) : (`install` as const);
    }
    if (mobile.value) {
        return `phone` as const;
    }
    return launched.value ? (`app` as const) : (`button` as const);
});
// Copying again helps a reader with a command not yet run, never a phone (clipboard was never the blocker).
const nudgeCopyable = computed(() => commandVisible.value && runTab.value !== `compose` && !(mobile.value && emailed.value));
const slowBuild = computed(
    () =>
        report.value === null &&
        claimedAt.value !== null &&
        handoff.value === `claimed` &&
        now.value - new Date(claimedAt.value).getTime() > SLOW_BUILD_MS,
);

// Last observable step before the user leaves for a terminal. `mobile` rides along since a phone's copy means
// something different (no terminal reads it).
const onCopied = (): void => {
    copied.value = true;
    track(`sandbox_command_copied`, { tab: runTab.value, sync: syncEnabled.value, mobile: mobile.value });
};

// Phone's handoff landed; its own milestone, not a flavour of `copied`, since it's the first observable phone
// action that leads anywhere.
const onEmailed = (): void => {
    emailed.value = true;
    track(`sandbox_setup_link_emailed`, { resuming: resuming.value });
};

// Local dev only: rides the localhost platform origin into the command; unchanged for the hosted platform.
const platformUrlOverride = computed<string | undefined>(() => {
    const api = new URL(environment.api.url);
    if (api.hostname !== `localhost` && api.hostname !== `127.0.0.1`) {
        return undefined;
    }
    return api.origin;
});

// Hands the setup to the desktop app: same code, same connect script, run by a process already on the machine.
const runHere = (): void => {
    const code = setup.value?.code;
    if (code === undefined || created.value === null) {
        return;
    }
    track(`desktop_setup_started`, { mode: mode.value, inApp: desktop.value, sync: syncEnabled.value });
    launched.value = true;
    openDesktopLink(
        desktopSetupLink({
            code,
            name: created.value.name,
            ...(mode.value === `own` ? { cfToken: cfToken.value.trim() } : {}),
            ...(syncEnabled.value ? { syncDir: syncDir.value } : {}),
            ...(platformUrlOverride.value ? { platformUrl: platformUrlOverride.value } : {}),
        }),
    );
};

// Platform has no machine to give (503/SERVICE_UNAVAILABLE only); not broken, so the card offers the other rung
// instead of a retry.
const isAtCapacity = (err: unknown): boolean => {
    if (err && typeof err === `object`) {
        const e = err as { code?: unknown; status?: unknown };
        return e.code === `SERVICE_UNAVAILABLE` || e.status === 503;
    }
    return false;
};

// oRPC surfaces a disabled endpoint as NOT_FOUND (404): the signal that the intentic-provided path is off.
const isNotFound = (err: unknown): boolean => {
    if (err && typeof err === `object`) {
        const e = err as { code?: unknown; status?: unknown };
        return e.code === `NOT_FOUND` || e.status === 404;
    }
    return false;
};

// lastSeenAt marks the daemon's last boot, not a heartbeat; redirects only once it advances past the baseline.
const baseline = ref<string | null>(null);
watch(
    () => created.value?.id,
    () => {
        baseline.value = created.value?.lastSeenAt ?? null;
    },
    { immediate: true },
);

// Why we're still waiting, or undefined; shown so a stuck wait names its cause instead of spinning silently.
const status = ref<string | undefined>(undefined);
// Poll in flight; a re-entrancy guard so the 3s interval doesn't stack requests. Deliberately not rendered.
const checking = ref(false);

// Lands on `/`, which differs by form factor (mobile has no docked chat, so it opens straight into a chat via
// `revealConversation`); navigates first, since selecting the sandbox rescopes the chat store.
const enterWorkspace = async (): Promise<void> => {
    await router.push(`/`);
    revealConversation(composingConversation());
};

// Polls the registry; opens the workspace once `lastSeenAt` advances past the baseline. Looks up the row by
// `created.id` in the fresh list, never via `sandbox.active`, which can point elsewhere mid-wait.
const check = async (): Promise<void> => {
    const pending = created.value;
    if (pending === null || checking.value || releaseRequested.value) {
        return;
    }
    // Code this poll asked about; a response after a re-mint must not report the previous command as claimed.
    const askedFor = mintedFor.value;
    const action = hostedAction;
    checking.value = true;
    try {
        const live = await sandbox.refresh();
        if (action !== hostedAction || pending.id !== created.value?.id || releasingHosted.value) {
            return;
        }
        // A reachable platform clears any earlier "can't reach" warning: it must not outlive its cause.
        status.value = undefined;
        const row = live.find((entry) => entry.id === pending.id);
        if (machine.value === `mine` && (row?.token !== pending.token || row?.hosted != null)) {
            return;
        }
        if (askedFor === mintedFor.value) {
            const claim = row?.setupCodeClaimedAt ?? null;
            if (claim !== null && claimedAt.value === null) {
                // Funnel's missing middle: command was pasted. A drop-off after this and before `sandbox_connected` is
                // Docker's.
                track(`sandbox_command_claimed`, { resuming: resuming.value });
            }
            claimedAt.value = claim;
            const reported = row?.setupReport ?? null;
            if (reported !== null && reported.failed.length > 0 && reportFailures.value === null) {
                // Counterpart to `sandbox_connected`: setup failed with a named cause, not a silent claim-to-connect
                // drop-off.
                track(`sandbox_setup_failed`, { stage: reported.stage, checks: reported.failed.map((failure) => failure.check).join(`,`) });
            }
            report.value = reported;
        }
        // What the sandbox has said about itself since: the wait card's two other sources.
        bootReport.value = row?.bootReport ?? null;
        announceRefusal.value = row?.announceRefusal ?? null;
        announced.value = (row?.lastSeenAt ?? null) !== null;
        // Machine state, asked only during a hosted wait, less often than the registry; failure keeps the last answer.
        if (row !== undefined && (row.hosted ?? null) !== null && machineTick++ % MACHINE_EVERY === 0) {
            hostedMachine.value =
                (await apiClient.sandbox.hostedStatus({ sandboxId: pending.id }).catch(() => undefined))?.machine ?? hostedMachine.value;
        }
        const seen = row?.lastSeenAt ?? null;
        if (action !== hostedAction || releasingHosted.value) {
            return;
        }
        // Holds the hosted lane on this card until reachable (a check-in only proves a start); silence passes through.
        // Or its boot chain is still converging: handing over would land on a second card that just repeats this one.
        const holding = hostedRow.value !== null && (hostedWait.value.reachable === false || hostedWait.value.booting);
        if (seen !== null && seen !== baseline.value && !holding) {
            // Onboarding's make-or-break milestone: the pasted command produced a live daemon.
            track(`sandbox_connected`, { resuming: resuming.value });
            finished.value = true;
            // Explicitly selects the sandbox just set up; `reconcileActive` may have moved the selection away while
            // waiting.
            sandbox.select(pending.id);
            await enterWorkspace();
        }
    } catch {
        status.value = `Can't reach the platform to check. Retrying…`;
    } finally {
        checking.value = false;
    }
};

// Creates the sandbox (mints its token) and activates it, unasked, on arrival; the mint watcher takes over once
// `created` holds a row. Name comes from setupName.ts.
const autoCreate = async (): Promise<void> => {
    if (creating.value) {
        return;
    }
    creating.value = true;
    error.value = null;
    try {
        const row = await sandbox.create(autoSandboxName(sandbox.sandboxes.value.map((entry) => entry.name)));
        created.value = row;
        // Minted here, agreed to by nobody: from this instant it is a draft the discard rule below owns.
        createdHere.value = true;
    } catch (err) {
        error.value = noticeFrom(err, `Could not create your sandbox.`);
    } finally {
        creating.value = false;
    }
};

// Re-reads what the account has left, since the count can change (e.g. releasing a hosted machine); a failed
// re-read keeps the last answer.
const refreshHostedOffer = async (): Promise<void> => {
    try {
        hostedOffer.value = await apiClient.sandbox.hostedOffer();
    } catch {
        // A platform that cannot be asked keeps the answer it already gave.
    }
};

// Retries the capacity read, not a provision attempt: drops the held refusal and asks again; nothing is spent
// either way.
const recheckCapacity = async (): Promise<void> => {
    hostedRefusedForRoom.value = false;
    hostedError.value = undefined;
    await refreshHostedOffer();
};

// Gives this row a platform-run machine, then lets the announce watch take over; a refusal costs only the
// attempt, leaving the sandbox untouched. Returns false if it didn't happen.
const provisionHosted = async (): Promise<boolean> => {
    const row = created.value;
    if (row === null || row.token === null || hostedBusy.value || releasingHosted.value) {
        return false;
    }
    hostedBusy.value = true;
    const action = ++hostedAction;
    hostedRequested.value = true;
    hostedError.value = undefined;
    try {
        const updated = await sandbox.hostedProvision(row.id, row.token);
        if (action !== hostedAction || machine.value !== `hosted` || created.value?.id !== row.id) {
            return false;
        }
        created.value = updated;
        hostedSince.value = Date.now();
        // Zero-command milestone: `sandbox_connected` will complete once this machine exists.
        track(`sandbox_hosted_created`, {});
        return true;
    } catch (err) {
        if (action !== hostedAction) {
            return false;
        }
        // No machines left isn't a failure notice; the card replaces itself with what to do instead.
        hostedRefusedForRoom.value = isAtCapacity(err);
        hostedError.value = noticeFrom(err, `Couldn't start a machine for you right now.`);
        return false;
    } finally {
        if (action === hostedAction) {
            hostedBusy.value = false;
            void refreshHostedOffer();
        }
    }
};

// The wait's one recovery: `remake` discards and rebuilds (a bad address), `reboot` restarts what exists (files
// kept). Clock restarts with the machine.
const restartHosted = async (): Promise<void> => {
    const row = created.value;
    if (row === null || hostedBusy.value || releasingHosted.value) {
        return;
    }
    const remake = hostedWait.value.failure?.action === `remake`;
    let released = false;
    const action = ++hostedAction;
    hostedBusy.value = true;
    hostedError.value = undefined;
    try {
        if (remake) {
            const updated = await sandbox.hostedRelease(row.id);
            if (action !== hostedAction) {
                return;
            }
            created.value = updated;
            baseline.value = null;
            released = true;
        } else {
            await apiClient.sandbox.hostedRestart({ sandboxId: row.id });
        }
        if (action !== hostedAction) {
            return;
        }
        // Whatever the machine last said about itself describes the boot we just replaced.
        bootReport.value = null;
        announceRefusal.value = null;
        announced.value = false;
        hostedMachine.value = undefined;
        hostedSince.value = Date.now();
    } catch (err) {
        if (action !== hostedAction) {
            return;
        }
        // A rebuild needs a new machine, so it can hit a full fleet like any provision, worded the same way.
        hostedRefusedForRoom.value = isAtCapacity(err);
        hostedError.value = hostedRefusedForRoom.value
            ? noticeOf(`We're out of machines right now, so we can't build you another one this minute.`, { tone: `warning` })
            : noticeFrom(err, `Couldn't start it over. Try again in a moment.`);
    } finally {
        if (action === hostedAction) {
            hostedBusy.value = false;
        }
    }
    // Outside the busy window on purpose (provisioning shares the flag); must not leave a machine handed back empty.
    if (released && action === hostedAction && machine.value === `hosted`) {
        await provisionHosted();
    }
};

// Cancellation must remain available while provisioning is in flight.
const chooseMachine = async (next: "hosted" | "mine"): Promise<void> => {
    const prev = machine.value;
    if (creating.value || releasingHosted.value || (next === `hosted` && hostedBusy.value)) {
        return;
    }
    if (next === prev) {
        return;
    }
    hostedError.value = undefined;
    const row = created.value;
    const rowHosted = (row?.hosted ?? null) !== null;
    // Choosing hosted starts nothing; the card below carries the button, so a picker click has no side effect.
    if (next === `hosted`) {
        machine.value = next;
        return;
    }
    if (row !== null && (rowHosted || hostedRequested.value || hostedBusy.value || releaseRequested.value)) {
        hostedAction += 1;
        releaseRequested.value = true;
        releasingHosted.value = true;
        hostedBusy.value = false;
        try {
            created.value = await sandbox.hostedRelease(row.id);
            releaseRequested.value = false;
            hostedRequested.value = false;
            hostedSince.value = undefined;
            baseline.value = null;
            bootReport.value = null;
            announceRefusal.value = null;
            announced.value = false;
            hostedMachine.value = undefined;
            claimedAt.value = null;
            report.value = null;
        } catch (err) {
            hostedError.value = noticeFrom(err, `Couldn't remove the machine we started. Try again in a moment.`);
            return;
        } finally {
            releasingHosted.value = false;
            void refreshHostedOffer();
        }
    }
    machine.value = next;
};

// Connect a sandbox that is ALREADY reachable: probe the pasted address from this browser, and only once the
// The connect token to present to the daemon being attached. The pasted token wins: it is the one the daemon
// is actually gating first-bind on. Otherwise the row's own (a resumed sandbox whose daemon was started from
// this account's own setup code); the row is this account's, so it carries one, but the shape allows null.
const attachConnectToken = (): string | undefined => {
    const pasted = attachToken.value.trim();
    return pasted !== `` ? pasted : (created.value?.token ?? undefined);
};

// daemon has authorized us record it on the platform. Verifying BEFORE creating anything means a typo can't
// leave an orphan sandbox behind; a retry after a failed attach re-uses
// the row the previous attempt created. On success there is nothing left to do: straight to the workspace.
const connectDomain = async (): Promise<void> => {
    const url = normalizedDomain.value;
    if (url === undefined || attaching.value) {
        return;
    }
    attaching.value = true;
    attachOutcome.value = undefined;
    error.value = null;
    try {
        const idToken = await getIdToken();
        if (idToken === undefined) {
            error.value = noticeOf(`Sign in with Google to reach your sandbox.`);
            return;
        }
        const connectToken = attachConnectToken();
        const outcome = await probeDaemon({ daemonUrl: url, idToken, ...(connectToken !== undefined ? { connectToken } : {}) });
        if (outcome.kind !== `ok`) {
            attachOutcome.value = outcome;
            return;
        }
        // Row normally exists already; this only covers a lane switch made while the arrival's create was still
        // failing.
        if (created.value === null) {
            await autoCreate();
        }
        const row = created.value;
        if (row === null) {
            return;
        }
        await sandbox.attach(row.id, url);
        // Same milestone as the provision lane's announce; the workspace must open on this sandbox specifically.
        track(`sandbox_connected`, { resuming: resuming.value, attached: true });
        finished.value = true;
        sandbox.select(row.id);
        await enterWorkspace();
    } catch (err) {
        error.value = noticeFrom(err, `Could not connect your sandbox.`);
    } finally {
        attaching.value = false;
    }
};

// Flips which lane step 1 heads; nothing is copied across since nothing is duplicated, including a half-finished
// attach.
const setLane = (next: "provision" | "attach"): void => {
    lane.value = next;
    attachOutcome.value = undefined;
    attachToken.value = ``;
    error.value = null;
    // The chooser that offered this lane has been answered; coming back must not find it still hanging open.
    reaching.value = false;
};

// The chooser's other answer: provision under the reader's own Cloudflare zone, a form rather than a lane, so
// only mode moves.
const chooseOwnZone = (): void => {
    mode.value = `own`;
    reaching.value = false;
};

// Mints the setup code (intentic path provisions the tunnel+DNS server-side first); NOT_FOUND means the feature
// is off, falling back to own-Cloudflare. Stale-target responses are dropped.
const mint = async (key: string): Promise<void> => {
    if (created.value === null) {
        return;
    }
    setupError.value = undefined;
    try {
        const minted = await apiClient.sandbox.setupCode({ sandboxId: created.value.id });
        if (key !== targetKey.value) {
            return;
        }
        setup.value = minted;
        mintedFor.value = key;
        // Fresh code means the handoff restarts: the old command was copied/handed, and the claim stamp just cleared.
        copied.value = false;
        launched.value = false;
        claimedAt.value = null;
    } catch (err) {
        if (isNotFound(err)) {
            // The platform runs no tunnel fabric: the attach lane is the only honest offer left.
            intenticAvailable.value = false;
        } else if (key === targetKey.value) {
            setupError.value = noticeFrom(err, `Couldn't prepare your install command. Try again.`);
        }
    }
};

// Locally-built dev image; without it connect.sh pulls `:stable`, whose daemon predates unreleased routes.
const DEV_SANDBOX_IMAGE = `intentic-sandbox:dev`;

// Dev tag only when invoked by path (checkout form), the only form with a repo to build the tag from.
const buildsFromCheckout = computed(() => platformUrlOverride.value !== undefined && scriptSource.value === `checkout`);

// Env suffix each command carries: local-dev PLATFORM_URL override (plus shared agent-auth volume and the dev
// image), and SYNC_DIR when sync is opted in.
const platformEnv = (): string =>
    platformUrlOverride.value
        ? ` PLATFORM_URL='${platformUrlOverride.value}' INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth'${
              buildsFromCheckout.value ? ` SANDBOX_IMAGE='${DEV_SANDBOX_IMAGE}'` : ``
          }`
        : ``;
const platformEnvPs = (): string =>
    platformUrlOverride.value
        ? `$env:PLATFORM_URL='${platformUrlOverride.value}'; $env:INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth'; ${
              buildsFromCheckout.value ? `$env:SANDBOX_IMAGE='${DEV_SANDBOX_IMAGE}'; ` : ``
          }`
        : ``;
const syncEnv = (): string => (syncEnabled.value ? ` SYNC_DIR='${syncDir.value}'` : ``);
const syncEnvPs = (): string => (syncEnabled.value ? `$env:SYNC_DIR='${syncDir.value}'; ` : ``);

// This page's own origin, sent as WEB_ORIGIN unless it matches the default; else the sandbox's CORS blocks it.
const webOrigin = (): string | undefined => (globalThis.location.origin === PLATFORM_WEB_ORIGIN ? undefined : globalThis.location.origin);
const webOriginEnv = (): string => {
    const origin = webOrigin();
    return origin === undefined ? `` : ` WEB_ORIGIN='${origin}'`;
};
const webOriginEnvPs = (): string => {
    const origin = webOrigin();
    return origin === undefined ? `` : `$env:WEB_ORIGIN='${origin}'; `;
};

// Command carries only the setup code, plus the CF token as an env var on the own-Cloudflare path (never
// stored). Everything between the pipe and `sh`: runner, then env assignments.
const linuxPrefix = (): string => {
    const envs = `${mode.value === `own` ? ` CF_TOKEN='${cfToken.value.trim()}'` : ``}${platformEnv()}${webOriginEnv()}${syncEnv()}`;
    // Root only installs Docker in production (hasDocker drops it); sudo in local dev breaks the pnpm-built image.
    const runner = environment.production && !hasDocker.value ? `sudo ` : ``;
    return `${runner}${envs === `` ? `` : `env${envs} `}`;
};

const windowsEnv = (code: string): string => {
    const cfEnv = mode.value === `own` ? `$env:CF_TOKEN='${cfToken.value.trim()}'; ` : ``;
    return `${platformEnvPs()}${webOriginEnvPs()}${cfEnv}${syncEnvPs()}$env:SETUP_CODE='${code}'; `;
};

const selectedCommand = computed(() => {
    const code = setup.value?.code;
    if (code === undefined) {
        return ``;
    }
    return cmdOs.value === `windows` ? psCommand(`ps1`, windowsEnv(code)) : bashCommand(`sh`, linuxPrefix(), code);
});
const selectedCommandLang = computed(() => commandLang(cmdOs.value));
// Uninstaller offered beside the installer; removes every container, volume and network the command creates.
const cleanupCommand = computed(() => (cmdOs.value === `windows` ? psCommand(`cleanupPs1`, ``) : bashCommand(`cleanup`, ``, ``)));

const composeArgs = computed<ComposeArgs | undefined>(() => {
    if (setup.value === null) {
        return undefined;
    }
    return {
        mode: mode.value,
        code: setup.value.code,
        hostname: setup.value.hostname,
        ...(mode.value === `own` ? { cfToken: cfToken.value.trim() } : {}),
        // Compose always references the published registry image, never the local `:dev` tag a deploy target can't
        // pull.
        image: `ghcr.io/intentic/sandbox:stable`,
        googleClientId: environment.auth.googleClientId,
        webOrigin: globalThis.location.origin,
        ...(platformUrlOverride.value ? { platformUrl: platformUrlOverride.value } : {}),
    };
});

// Which sandbox this page sets up: an id in the URL, else the account's one unfinished sandbox if it has no
// working one, else a fresh one created on the spot. Gated on no connected sandbox existing anywhere; owned only.
// Distinguishes resuming an errand from adopting a blank draft: a row exists from the moment /setup opens, so
// simply finding one again (reload, tab reopen, the app's first frame) must not be read as a history. Only
// genuine acts count.
const touched = (row: SandboxSummary): boolean =>
    // `?? null` on each: fields are optional as well as nullable, and `undefined !== null` would touch every row.
    (row.lastSeenAt ?? null) !== null ||
    (row.setupCodeClaimedAt ?? null) !== null ||
    (row.setupReport ?? null) !== null ||
    (row.hosted ?? null) !== null;

// One offer read: a 404 is a real answer (feature genuinely off), but a timeout/drop/500 says nothing and must
// not be recorded as one. Resolve-then-call so a missing client method lands in the catch, not on mount.
const readOffer = <T,>(call: () => Promise<T>, absent: T): Promise<OfferRead<T>> =>
    Promise.resolve()
        .then(async (): Promise<OfferRead<T>> => ({ kind: `answered`, value: await call() }))
        .catch((err: unknown): OfferRead<T> => (isNotFound(err) ? { kind: `answered`, value: absent } : { kind: `unreachable` }));

// Fans the two reads out to three destinations answering different questions; a lost read resets
// `intenticAvailable` to undefined, not false, so nothing false gets printed and nothing has to be retracted.
const recordOffers = (hosted: OfferRead<HostedOffer>, address: OfferRead<AddressOffer>): void => {
    hostedRead.value = hosted;
    addressRead.value = address.kind === `answered` ? { kind: `answered`, value: address.value.enabled } : { kind: `unreachable` };
    hostedOffer.value = hosted.kind === `answered` ? hosted.value : { enabled: false, remaining: 0 };
    intenticAvailable.value = address.kind === `answered` ? address.value.enabled : undefined;
};

const arrive = async (): Promise<void> => {
    // Offers land together with the row list, so the ladder and address line are right on the first frame.
    const [rows, hosted, address] = await Promise.all([
        sandbox.list(),
        readOffer(() => apiClient.sandbox.hostedOffer(), { enabled: false, remaining: 0 }),
        readOffer(() => apiClient.sandbox.addressOffer(), { enabled: false }),
    ]);
    recordOffers(hosted, address);
    const requested = route.query[`sandbox`];
    const named = typeof requested === `string` ? rows.find((entry) => entry.id === requested) : undefined;
    const unfinished = rows.some((entry) => entry.lastSeenAt !== null)
        ? undefined
        : rows.find((entry) => entry.role === `owner` && entry.lastSeenAt === null);
    const found = named ?? unfinished;
    if (found?.role !== `owner`) {
        await autoCreate();
    } else {
        sandbox.select(found.id);
        created.value = found;
        resuming.value = touched(found);
        // Resumed sandbox already hosted continues that story; booting or asleep is handled by the wake reflex.
        if ((found.hosted ?? null) !== null) {
            machine.value = `hosted`;
            hostedSince.value = Date.now();
            void warmSandboxCredential();
        }
    }
    // A rung picked before this page outranks the arrival: preselects the picker and is `arrivalFor`'s own answer.
    const asked = requestedMachine();
    if (asked !== undefined) {
        machine.value = asked;
    }
    // What this page does unasked (setupArrival.ts); decided here since every input is one of the two reads above.
    arrival.value = arrivalFor({
        inApp: desktop.value,
        touched: resuming.value,
        // Only `autoCreate` sets this, so it's exactly true: the row was minted by this visit and nothing else.
        fresh: createdHere.value,
        hostedOffered: hostedOffered.value,
        hostedSpent: hostedSpent.value,
        hostedFull: hostedFull.value,
        commandOffered: commandOffered.value,
        requestedMachine: asked,
        elsewhere: elsewhere.value,
    });
    // Nothing takeable means nothing to start; the page states which of the four lane facts holds, never switches.
    if (!laneTakeable.value) {
        return;
    }
    // Browser's answer, taken automatically; a refusal puts the picker back with the reason on the card, rung shown.
    if (arrival.value === `hosted`) {
        machine.value = `hosted`;
        if (!(await provisionHosted())) {
            arrival.value = `choose`;
            return;
        }
        void warmSandboxCredential();
        return;
    }
    // The app's answer is this computer, and the handoff below fires it the moment there is a code to hand.
    if (arrival.value === `local`) {
        machine.value = `mine`;
    }
};

// Retries the arrival read; safe to run twice since it finds the same unfinished row rather than creating a
// second one. `loaded` drops during the round trip so the spinner replaces the card.
const retryArrival = async (): Promise<void> => {
    loaded.value = false;
    try {
        await arrive();
    } finally {
        loaded.value = true;
    }
};

// Fires the app handoff once a code exists for the `local` arrival, one shot only: a re-mint (lane switch,
// retry) is ordinary here and must not reopen the app's installer window each time.
const handedOff = ref(false);
watch([arrival, commandReady], () => {
    if (arrival.value !== `local` || !commandReady.value || handedOff.value) {
        return;
    }
    handedOff.value = true;
    runHere();
});

onMounted(async () => {
    try {
        await arrive();
    } finally {
        // Read finished or threw either way; a thrown read leaves the retry card instead of a spinner that never stops.
        loaded.value = true;
    }
});

// Draft rule: the row created on arrival is a draft until an act commits it, never a guess from elapsed time:
//   the command is on a clipboard, in an inbox, or handed to the app
//   a machine of ours exists
//   a machine redeemed the code, or reported on its run
//   the daemon checked in, or an attach bound one
// Lane, rung, disclosures, and an unverified pasted token or domain don't count.
const committed = computed(
    () =>
        finished.value ||
        copied.value ||
        launched.value ||
        emailed.value ||
        claimedAt.value !== null ||
        report.value !== null ||
        announced.value ||
        hostedRow.value !== null,
);

// Deletes the draft row and its tunnel so a peek leaves nothing behind; fire-and-forget, since every caller is
// already navigating away. A failure is swallowed; an outliving row is what the switcher's unfinished section
// catches.
const discardDraft = (): void => {
    const row = created.value;
    if (row === null || !createdHere.value || committed.value) {
        return;
    }
    createdHere.value = false;
    created.value = null;
    void sandbox.remove(row.id).catch(() => undefined);
};

// Forgets a resumed sandbox and starts a new one; everything derived from the old one (code, hostname,
// subdomain) resets too.
const startFresh = (): void => {
    // Walking away from a row this visit minted discards it, same as leaving the page; a resumed row is untouched.
    discardDraft();
    resuming.value = false;
    created.value = null;
    error.value = null;
    setup.value = null;
    mintedFor.value = undefined;
    setupError.value = undefined;
    // Abandoned hosted sandbox keeps existing; the fresh one starts classic, since the allowance is likely spent.
    hostedSince.value = undefined;
    machine.value = `mine`;
    // Arrival is spent: the replacement lands on the picker, not another auto-started machine; handoff is released.
    arrival.value = `choose`;
    handedOff.value = false;
    // Handoff facts (copied, launched, claimed) belonged to the abandoned command; irrelevant to the next sandbox.
    copied.value = false;
    launched.value = false;
    claimedAt.value = null;
    subdomain.value = ``;
    derivedPrefix.value = ``;
    // Attach inputs described the abandoned sandbox; otherwise a stale domain sits ready to attach to the next one.
    domain.value = ``;
    attachToken.value = ``;
    attachOutcome.value = undefined;
    void router.replace({ path: `/setup` }); // drop ?sandbox= so a reload doesn't re-resume
    // There is no blank form to drop to any more: the replacement is created here, exactly as it is on arrival.
    void autoCreate();
};

// Watch the registry while we sit on /setup; the moment the daemon reports in, open the workspace.
const timer = setInterval(() => void check(), 3000);

// Rechecks on refocus, since a hidden tab (the whole install, inside the app) throttles the 3s timer to much
// longer. `check` is re-entrant, so this costs nothing mid-poll.
const recheck = (): void => {
    if (document.visibilityState === `visible`) {
        void check();
    }
};
document.addEventListener(`visibilitychange`, recheck);
window.addEventListener(`focus`, recheck);

onUnmounted(() => {
    hostedAction += 1;
    clearInterval(timer);
    clearTimeout(mintTimer);
    document.removeEventListener(`visibilitychange`, recheck);
    window.removeEventListener(`focus`, recheck);
    // Leaving without committing discards the draft; the only exit hook, since beforeunload can't hold a round trip.
    discardDraft();
});

// Mints the code once the target completes, debounced against keystrokes; a switch re-fires this on its own.
watch(
    targetKey,
    () => {
        clearTimeout(mintTimer);
        const key = targetKey.value;
        if (key === undefined || created.value === null || mintedFor.value === key) {
            return;
        }
        mintTimer = setTimeout(() => void mint(key), 500);
    },
    { immediate: true },
);

// Retries a failed mint; the watcher above only fires on a changed target, and a failure doesn't change what
// was asked for.
const remint = (): void => {
    const key = targetKey.value;
    if (key === undefined) {
        return;
    }
    setupError.value = undefined;
    void mint(key);
};

// Derives the default sandbox-<hash> prefix (mirrors the CLI); pre-fills subdomain if the user hasn't typed one.
watch(
    // The setup wizard is the owner's, so the row it creates carries its token; null (a member's row) never reaches here.
    () => created.value?.token ?? undefined,
    async (token) => {
        if (token === undefined) {
            return;
        }
        derivedPrefix.value = sandboxSubdomain(await sandboxIdFromToken(token));
        if (subdomain.value === ``) {
            subdomain.value = derivedPrefix.value;
        }
    },
    { immediate: true },
);

// Warms the browser→sandbox Google credential the moment the command is ready, fired once; silent only; a full
// sign-in gate here would ask the user to sign in twice before anything is even running.
let credentialWarmed = false;
watch(commandReady, (ready) => {
    if (ready && !credentialWarmed) {
        credentialWarmed = true;
        void warmIdToken();
    }
});

// Hosted lane's version of the same warming, since it never renders a command to trigger the watcher above;
// makes one silent attempt (never the full gate) while the reader watches the machine boot.
const warmSandboxCredential = async (): Promise<void> => {
    await warmIdToken();
    if ((await getIdToken({ interactive: false })) === undefined) {
        await getIdToken({ silent: true });
    }
};
</script>

<template>
    <!-- dvh not vh: a phone's collapsing chrome makes 100vh taller than the screen, hiding the last step. -->
    <div class="entry vestibule scrollbar-thin w-full overflow-auto">
        <!-- Reuses the sign-in screen's plaque art, cropped to a band, dissolved by the veil: depth behind the masthead. -->
        <div class="entry-plate" aria-hidden="true">
            <div class="entry-plate-img"></div>
            <div class="entry-veil"></div>
        </div>

        <!-- 74rem = max-w-3xl steps + gap + the aside's width; keep in step if the aside's width changes. -->
        <div
            class="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 md:gap-4 md:px-6 md:py-8 xl:max-w-[74rem]"
        >
            <!-- Masthead: mark, eyebrow, heading and lede, left-aligned, as the site lays out every page but the home page. -->
            <header class="masthead">
                <div class="mast-top">
                    <AppBrand class="mast-brand" />
                    <!-- Escape hatch for a returning user (requireSetup lets them into `/`); hidden via `otherWorkspace`, not length. -->
                    <Button
                        v-if="otherWorkspace"
                        :as="RouterLink"
                        to="/"
                        label="Back to workspace"
                        severity="secondary"
                        :text="true"
                        class="mast-back shrink-0"
                    >
                        <template #icon><Icon name="arrow-left" /></template>
                    </Button>
                </div>

                <!-- Matches the sign-in rail's second beat verbatim; true in both lanes, since attach means already reachable. -->
                <p class="entry-eyebrow mast-eyebrow">
                    <span class="entry-lozenge"></span>
                    <span>Your sandbox is waiting</span>
                </p>

                <!-- One sentence only; the door's headline gets two, but here the loudest thing on screen has to be a rung. -->
                <h1 class="mast-headline"><span class="entry-display">Set up your workspace</span><span class="entry-stop">.</span></h1>

                <!-- Lede must match the lane and ask a question only when the picker actually shows, keyed on `ladderShown`. -->
                <p class="mast-lede">
                    <template v-if="lane === `attach`">Point intentic at the sandbox you're already running. One address, and you're in.</template>
                    <!-- Nothing to start, so no promised minute or two; reads the same verdict the card below does. -->
                    <template v-else-if="loaded && !laneTakeable">Here's what this platform can do for you.</template>
                    <template v-else-if="ladderShown">Pick where it runs. You'll be working in it in a minute or two.</template>
                    <template v-else-if="machine === `hosted`">We're starting a machine for you. You'll be working in it in about a minute.</template>
                    <template v-else-if="desktop">Setting it up on this computer. You'll be working in it in a minute or two.</template>
                    <!-- One rung, no picker, nothing started yet; names the lane without claiming work that hasn't begun. -->
                    <template v-else>It runs on a computer of yours. You'll be working in it in a minute or two.</template>
                </p>
            </header>

            <!-- Two columns from xl (steps + docked panel); below that, one column and the panel folds into step 2's (i) hint. -->
            <div class="flex flex-col gap-3 md:gap-4 xl:flex-row xl:items-start xl:gap-6">
                <div class="flex min-w-0 flex-1 flex-col gap-3 md:gap-4 xl:max-w-3xl">
                    <!-- Titled since it asks for something (a form needs a heading); an icon, not a number, since there's no step 2. -->
                    <StepSection v-if="lane === `attach`" icon="link" title="Connect your sandbox" class="entry-frame rounded-none work-card">
                        <!-- Corners are absolutely positioned against `.entry-frame`; this lane earns the same ornament as the run card. -->
                        <span class="entry-corner entry-corner-tl"></span>
                        <span class="entry-corner entry-corner-tr"></span>
                        <span class="entry-corner entry-corner-bl"></span>
                        <span class="entry-corner entry-corner-br"></span>
                        <!-- Explains why the page (not the reader) chose this lane; else 'give us your domain' reads as a missing step. -->
                        <p v-if="!provisionOffered" class="flex items-start gap-2 text-xs text-muted">
                            <Icon name="info-circle" class="mt-0.5 shrink-0" />
                            <span>This platform doesn't start sandboxes or hand out addresses: it connects to one you're already running.</span>
                        </p>
                        <p class="text-xs text-muted">
                            Already running the sandbox container behind a domain of your own? Give us the address it answers on. We'll check it, then
                            open your workspace. Nothing to install, nothing to provision.
                        </p>
                        <label class="ui-field">
                            <span class="ui-field-label">Domain</span>
                            <!-- Stacked on a phone; side by side, the field loses half its width and the typed address scrolls out of view. -->
                            <div class="flex flex-col gap-2 md:flex-row md:items-center">
                                <input
                                    v-model="domain"
                                    autocomplete="off"
                                    autocapitalize="off"
                                    spellcheck="false"
                                    placeholder="sandbox.example.com"
                                    :class="ui.input('w-full')"
                                    @keydown.enter="connectDomain"
                                />
                                <!-- attaching gates disabled too, not just loading: the theme has no disabled tokens, so loading alone looks live. -->
                                <Button
                                    label="Connect"
                                    class="w-full justify-center md:w-fit"
                                    :loading="attaching"
                                    :disabled="attaching || normalizedDomain === undefined"
                                    @click="connectDomain"
                                >
                                    <template #icon><Icon name="link" /></template>
                                </Button>
                            </div>
                            <span v-if="domainProblem" class="text-xs text-warning">{{ domainProblem }}</span>
                            <span v-else-if="normalizedDomain" class="text-xs text-muted"
                                >We'll connect to <span>{{ normalizedDomain }}</span
                                >.</span
                            >
                            <span v-else class="text-xs text-muted">The https address your sandbox already answers on (https:// is optional).</span>
                        </label>

                        <!-- Each probe failure names the one thing the user can do about it. -->
                        <Notice v-if="attachOutcome?.kind === `unreachable`" :of="{ tone: `danger`, title: `Nothing answered at that address.` }">
                            <span class="mt-0.5 block text-2xs">
                                Check the sandbox is running and the domain points at it. The daemon's <code>WEB_ORIGIN</code> also has to name
                                <span>{{ webOrigin() ?? PLATFORM_WEB_ORIGIN }}</span
                                >. Otherwise your browser blocks the call before it's sent.
                            </span>
                        </Notice>
                        <Notice
                            v-else-if="attachOutcome?.kind === `timeout`"
                            :of="{
                                tone: `danger`,
                                title: `That address accepted the connection but never answered.`,
                                detail: `Something is listening, but it isn't replying: a sandbox still starting up, or a proxy pointed at the wrong port. Give it a moment and try again.`,
                            }"
                        />
                        <!-- Tunnel alive, no sandbox behind it: usually a resumed sandbox's container is gone; named as that, not a 530. -->
                        <Notice
                            v-else-if="attachOutcome?.kind === `no-origin`"
                            :of="{ tone: `danger`, title: `That domain is live, but no sandbox is running behind it.` }"
                        >
                            <span class="mt-0.5 block text-2xs">
                                Its tunnel or reverse proxy answered {{ attachOutcome.status }} with nothing to forward to. Start the sandbox
                                container<template v-if="created !== null"
                                    >, or get a domain from intentic and run the install command instead</template
                                >.
                            </span>
                        </Notice>
                        <template v-else-if="attachOutcome?.kind === `needs-token`">
                            <Notice :of="{ tone: `warning`, title: `Your sandbox is up, but it wouldn't let us in yet.` }">
                                <span class="mt-0.5 block text-2xs"
                                    >It's waiting to be claimed with the connection token it was started with. Paste that
                                    <code>CONNECT_TOKEN</code> to claim it as yours.</span
                                >
                            </Notice>
                            <label class="ui-field">
                                <span class="ui-field-label">Connection token</span>
                                <input
                                    v-model="attachToken"
                                    type="password"
                                    autocomplete="off"
                                    autocapitalize="off"
                                    spellcheck="false"
                                    placeholder="The CONNECT_TOKEN your sandbox runs with"
                                    :class="ui.input('w-full')"
                                    @keydown.enter="connectDomain"
                                />
                                <span class="text-xs text-muted">
                                    Used once to claim the sandbox. The daemon stops asking once you're bound, so intentic never stores it.
                                </span>
                            </label>
                        </template>
                        <Notice
                            v-else-if="attachOutcome?.kind === `denied`"
                            :of="{
                                tone: `danger`,
                                title: attachOutcome.message,
                                detail: `Ask its owner to invite ${user?.email ?? `you`}, then connect it again.`,
                            }"
                        />
                        <Notice
                            v-else-if="attachOutcome?.kind === `rejected`"
                            :of="{ tone: `danger`, title: `That sandbox refused the connection.`, detail: attachOutcome.message }"
                        />

                        <Notice v-if="error" :of="error" />
                        <!-- Label says whether going back continues an existing row or starts fresh; hidden with nothing to go back to. -->
                        <button
                            v-if="provisionOffered"
                            type="button"
                            :class="ui.linkButton(`text-muted underline hover:text-content`)"
                            @click="setLane(`provision`)"
                        >
                            {{ created === null ? `← Set one up for me instead` : `← Get a domain from intentic instead` }}
                        </button>
                    </StepSection>

                    <!-- Naming lives inside the workspace; this space holds only exceptional arrival state, before the machine choice. -->
                    <!-- Renders only before `created` exists (or a resumed row); `!loaded` alone once drew this beside the run card. -->
                    <div v-else-if="created === null || resuming" class="flex flex-col items-start gap-2 py-1">
                        <template v-if="created === null">
                            <!-- Reading offers and minting the row are one wait to the reader, so they render as one line, not two states. -->
                            <p v-if="!loaded || creating" class="flex items-center gap-2 text-xs text-muted">
                                <Icon name="spinner" spin class="text-info" />
                                Setting one up for you. Nothing to fill in.
                            </p>
                            <template v-else>
                                <Notice v-if="error" :of="error" />
                                <Button label="Try again" class="w-full justify-center md:w-fit" @click="autoCreate">
                                    <template #icon><Icon name="refresh" /></template>
                                </Button>
                            </template>
                            <!-- Held back until `loaded`: offering attach is honest only once we know what the platform can do; can't flicker. -->
                            <button v-if="loaded" type="button" :class="ui.linkButton()" @click="setLane(`attach`)">
                                Already running a sandbox somewhere? Connect it by domain →
                            </button>
                        </template>
                        <p v-else class="text-xs text-muted">
                            {{
                                neverStarted
                                    ? `Picking up where you left off: nothing has run yet.`
                                    : `Still on the platform, the cleanup only cleared its local container.`
                            }}
                            <button type="button" class="cursor-pointer text-link hover:underline" @click="startFresh">
                                Use a new sandbox instead</button
                            >.
                        </p>
                    </div>

                    <!-- Replaces auto-switching to attach on a failed or empty offer; states which lane fact is true instead. -->
                    <div v-if="loaded && lane === `provision` && !laneTakeable" class="flex flex-col items-start gap-3 py-1">
                        <!-- Could not ask; offers a retry, not a verdict that the platform provisions nothing on a failed request. -->
                        <template v-if="lanes.kind === `unreachable`">
                            <Notice
                                :of="{
                                    tone: `warning`,
                                    title: `We couldn't reach the platform to see what it can start for you.`,
                                    detail: `Nothing is wrong with your account — the check itself didn't get through.`,
                                }"
                            />
                            <Button label="Try again" class="w-full justify-center md:w-fit" @click="retryArrival">
                                <template #icon><Icon name="refresh" /></template>
                            </Button>
                        </template>
                        <!-- Named remedy only when on screen: `otherWorkspace` needs a reported-in sandbox, which the holder may not be. -->
                        <template v-else-if="lanes.kind === `spent`">
                            <Notice
                                :of="{
                                    tone: `info`,
                                    title: `Your free machine is already running another sandbox.`,
                                    detail: otherWorkspace
                                        ? `Open that one from the top of this page, or connect a sandbox you're running yourself.`
                                        : `Connect a sandbox you're running yourself instead.`,
                                }"
                            />
                        </template>
                        <!-- Self-hosted with no fabric: attach is the whole product here, stated as a deployment fact, not a failure. -->
                        <template v-else>
                            <Notice
                                :of="{
                                    tone: `info`,
                                    title: `This platform doesn't start sandboxes or hand out addresses.`,
                                    detail: `It connects to one you're already running.`,
                                }"
                            />
                        </template>
                        <button type="button" :class="ui.linkButton()" @click="setLane(`attach`)">
                            Already running a sandbox somewhere? Connect it by domain →
                        </button>
                    </div>

                    <!--
                        Card is what you do (command, two switches, one state line); what it means moved to SetupRunDetails, docked
                        or folded into (i). On a phone the card is one sentence plus the handoff; the command's detail lives there
                        instead.
                    -->

                    <!-- No heading: it could only name one of three answers below, and the chooser says it better than a title could. -->
                    <!-- Ladder is its own row outside every card, not nested in the run card, so it isn't read as a step's detail. -->
                    <div v-if="created && lane === `provision` && ladderShown" ref="ladderRow" class="flex flex-col gap-2">
                        <!-- One column per rung, so two rungs are two halves, not two thirds of a row with a hole for the third. -->
                        <div
                            class="grid gap-3"
                            :class="ladderOptions.length === 2 ? `sm:grid-cols-2` : `sm:grid-cols-3`"
                            role="radiogroup"
                            aria-label="Where the sandbox runs"
                        >
                            <!-- Choosing a rung turns its corners gold (the page's one selection signal), not a border tint easy to miss. -->
                            <button
                                v-for="option in ladderOptions"
                                :key="option.value"
                                type="button"
                                role="radio"
                                :aria-checked="machine === option.value"
                                :disabled="releasingHosted || (option.value === `hosted` && (hostedBusy || hostedSpent))"
                                class="rung"
                                :class="machine === option.value ? `rung-on` : ``"
                                v-action="() => chooseMachine(option.value)"
                            >
                                <span class="entry-corner entry-corner-tl"></span>
                                <span class="entry-corner entry-corner-tr"></span>
                                <span class="entry-corner entry-corner-bl"></span>
                                <span class="entry-corner entry-corner-br"></span>
                                <!-- A drawing, not a glyph (SetupRungArt); the spinner replaces it (`invisible`, not gone), so height never jumps. -->
                                <span class="mb-1 grid w-full grid-cols-1 grid-rows-1">
                                    <SetupRungArt
                                        :kind="option.value"
                                        :selected="machine === option.value"
                                        class="col-start-1 row-start-1"
                                        :class="hostedBusy && option.value === `hosted` ? `invisible` : ``"
                                    />
                                    <span
                                        v-if="hostedBusy && option.value === `hosted`"
                                        class="col-start-1 row-start-1 flex items-center justify-center"
                                    >
                                        <Icon name="spinner" spin class="text-xl text-link" />
                                    </span>
                                </span>
                                <!-- Mark on the title's own line, not above it, so the name reads as a station on the row, not an adjacent card. -->
                                <span class="rung-name">
                                    <span class="entry-lozenge"></span>
                                    <span class="min-w-0">{{ option.title }}</span>
                                </span>
                                <!-- Cost gets its own colour: the one line a reader compares across the row rather than reading down. -->
                                <span class="rung-cost">{{ option.meta }}</span>
                                <!-- Three or four words on what a rung asks or where it puts the machine; longer prose moved under the row. -->
                                <span class="text-xs leading-snug text-subtle">{{ option.note }}</span>
                                <!-- The allowance is spent, and saying so beats hiding a rung the reader was
                                     offered on their first sandbox. -->
                                <span v-if="option.value === `hosted` && hostedSpent" class="text-xs text-warning">Already using yours</span>
                            </button>
                        </div>
                    </div>

                    <!-- One framed object with the finial (as the sign-in gate wears it): the consequence every choice above leads to. -->
                    <!-- Gated on `laneTakeable`: nothing to mint or start would sit locked forever; the card above states the truth. -->
                    <section v-if="created && lane === `provision` && laneTakeable" class="entry-frame work-card run-card flex flex-col gap-4">
                        <span class="entry-corner entry-corner-tl"></span>
                        <span class="entry-corner entry-corner-tr"></span>
                        <span class="entry-corner entry-corner-bl"></span>
                        <span class="entry-corner entry-corner-br"></span>
                        <span class="entry-finial" aria-hidden="true"><AppBrand shape="mark" /></span>
                        <!-- Leads the card in every lane, so phrases like 'the token above' always point at something actually on screen. -->
                        <div class="flex flex-col gap-2">
                            <!-- One group across every state, so the escape hatch beside it stays reachable even when the mint has errored. -->
                            <!-- Stacked on a phone: a label column left too little room for a hostname, read character by character. -->
                            <div
                                v-if="addressFact !== `own`"
                                class="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 sm:min-h-8 sm:grid-cols-facts sm:content-center sm:items-baseline"
                            >
                                <span :class="factLabel">Address</span>
                                <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                                    <!-- Keyed on the rung, not the machine: a chosen hosted rung with no machine must not fall to the mint spinner. -->
                                    <template v-if="addressFact === `hosted`">
                                        <span v-if="hostedHost" :class="factHost">{{ hostedHost }}</span>
                                        <span v-else-if="hostedRow !== null" :class="`${factSlot} gap-2 text-xs text-muted`">
                                            <Icon name="spinner" spin class="self-center" /> Assigned as your machine starts…
                                        </span>
                                        <!--
                                            No machine to be had means the address line must not promise one, contradicting 'we're out of machines'
                                            below.
                                        -->
                                        <span v-else :class="`${factSlot} text-xs text-muted`">{{
                                            hostedFull ? `Assigned when a machine frees up` : `Assigned when your machine starts`
                                        }}</span>
                                    </template>
                                    <!-- Platform mints no addresses: a fact, not a wait, so no spinner and no hatch (both alternatives mint too). -->
                                    <span v-else-if="addressFact === `none`" :class="`${factSlot} text-xs text-muted`">
                                        This platform doesn't set one up
                                    </span>
                                    <template v-else>
                                        <!-- `.title`: interpolating the NoticeModel itself would render its JSON. -->
                                        <span v-if="setupError" :class="`${factSlot} text-xs text-danger`">{{ setupError.title }}</span>
                                        <span v-else-if="setup" :class="factHost">{{ setup.hostname }}</span>
                                        <span v-else :class="`${factSlot} gap-2 text-xs text-muted`">
                                            <Icon name="spinner" spin class="self-center" /> Preparing your intentic domain…
                                        </span>
                                        <!--
                                            One escape hatch, not two separate links asking the same question; each choice under it states what it
                                            does.
                                        -->
                                        <button type="button" :class="ui.linkButton()" @click="reaching = !reaching">
                                            {{ reaching ? `Keep this address` : `Use a different address` }}
                                        </button>
                                    </template>
                                </div>
                            </div>

                            <!-- Overflow from the address row; used to be a bordered inset with captions, now labels carry the distinction. -->
                            <p v-if="addressFact === `none`" class="text-xs text-muted">
                                Sandboxes here are reached at an address you already have. Already running one?
                                <button type="button" class="cursor-pointer text-link hover:underline" @click="setLane(`attach`)">
                                    Connect the domain it answers on</button
                                >.
                            </p>
                            <p v-else-if="addressFact === `intentic` && reaching" class="text-xs text-muted">
                                Use
                                <button type="button" class="cursor-pointer text-link hover:underline" @click="chooseOwnZone">
                                    your own Cloudflare zone</button
                                >, or connect
                                <button type="button" class="cursor-pointer text-link hover:underline" @click="setLane(`attach`)">
                                    a domain it already answers on</button
                                >.
                            </p>

                            <!-- Own Cloudflare: token, zone, editable subdomain; the way back sits by the (i), since there's no header now. -->
                            <template v-if="addressFact === `own`">
                                <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                    <button v-if="intenticAvailable" type="button" :class="ui.linkButton()" @click="mode = `intentic`">
                                        ← Use intentic's domain
                                    </button>
                                    <InfoHint label="Why the Cloudflare API token is required">
                                        <p class="mb-1 text-sm font-medium text-content">Why this token?</p>
                                        <p class="mb-3 text-xs leading-relaxed text-muted">
                                            intentic reaches your sandbox over a private Cloudflare tunnel, with no open inbound ports.
                                        </p>
                                        <ul class="flex flex-col gap-2 text-xs text-muted">
                                            <li class="flex items-start gap-2">
                                                <Icon name="bolt" class="mt-0.5 text-link" />
                                                <span>Lets the install command <span class="text-content">create the tunnel</span></span>
                                            </li>
                                            <li class="flex items-start gap-2">
                                                <Icon name="lock" class="mt-0.5 text-success" />
                                                <span
                                                    ><span class="text-content">Never stored by intentic</span>: used once to list zones, then rides
                                                    the command</span
                                                >
                                            </li>
                                        </ul>
                                    </InfoHint>
                                </div>
                                <CloudflareTokenField
                                    :cf="cf"
                                    storage-note="Used once to look up your Cloudflare zones, then it rides the command into your sandbox, never stored by intentic."
                                />

                                <!-- Zone suffix wraps to its own line rather than stealing width from the subdomain field, which a phone lacked. -->
                                <label v-if="selectedZone" class="ui-field">
                                    <span class="ui-field-label">Domain</span>
                                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                        <input
                                            :value="subdomain"
                                            @input="subdomain = ($event.target as HTMLInputElement).value"
                                            autocomplete="off"
                                            autocapitalize="off"
                                            spellcheck="false"
                                            placeholder="sandbox"
                                            :class="ui.input('w-full md:w-auto md:min-w-0 md:flex-1')"
                                        />
                                        <span class="text-sm break-words text-subtle">.{{ selectedZone }}</span>
                                    </div>
                                    <span v-if="!subdomainValid" class="text-xs text-warning">Use letters, numbers and hyphens only.</span>
                                    <span v-else class="text-xs text-success"
                                        >✓ Your sandbox will be reachable at <span class="break-words">{{ subdomain.trim() }}.{{ selectedZone }}</span
                                        >.</span
                                    >
                                </label>
                            </template>
                        </div>

                        <!-- Kept separate from the arrival notice so a lane change doesn't erase it; a full fleet isn't shown twice. -->
                        <Notice v-if="hostedError && !hostedFull" :of="hostedError" />

                        <!-- Steps ticking while going fine, or what broke and what's next otherwise, never both (hostedWait.ts decides). -->
                        <template v-if="machine === `hosted`">
                            <template v-if="hostedRow !== null">
                                <!-- Step list is gone here on purpose; ticking beside a stated failure would be the page arguing with itself. -->
                                <template v-if="hostedWait.failure">
                                    <p class="flex items-start gap-2 text-xs text-content">
                                        <Icon name="exclamation-circle" class="mt-0.5 shrink-0 text-warning" />
                                        <span>{{ hostedWait.failure.problem }}</span>
                                    </p>
                                    <p class="text-xs text-muted">{{ hostedWait.failure.remedy }}</p>
                                    <Button
                                        label="Start it over"
                                        class="w-full justify-center md:w-fit"
                                        :disabled="hostedBusy"
                                        @click="restartHosted"
                                    >
                                        <template #icon><Icon name="refresh" /></template>
                                    </Button>
                                </template>
                                <!-- Healthy wait: one row per step, current one spinning; naming where we are beats one sentence saying so. -->
                                <template v-else>
                                    <ul class="flex flex-col gap-1.5">
                                        <li
                                            v-for="step in hostedWait.steps"
                                            :key="step.key"
                                            class="flex items-center gap-2 text-xs"
                                            :class="step.state === `todo` ? `text-subtle` : `text-content`"
                                        >
                                            <Icon
                                                :name="step.state === `done` ? `check` : step.state === `active` ? `spinner` : `circle`"
                                                :spin="step.state === `active`"
                                                class="shrink-0 text-xs"
                                                :class="
                                                    step.state === `done` ? `text-success` : step.state === `active` ? `text-info` : `text-subtle`
                                                "
                                            />
                                            <span>{{ step.label }}</span>
                                        </li>
                                    </ul>
                                    <!-- Promise comes from hostedWait.ts (origin's estimate, then elapsed minutes); a download reads as counted work. -->
                                    <p class="text-xs text-muted">{{ hostedWait.note }}</p>
                                </template>
                            </template>
                            <p v-else-if="hostedBusy" class="flex items-center gap-2 text-xs text-content">
                                <Icon name="spinner" spin class="text-info" />
                                Starting a machine for you…
                            </p>
                            <!-- This is the commitment, not the description above; the no-backup fact is stated here, where someone decides. -->
                            <!-- Full fleet: the button that can't work isn't drawn; `Check again` re-reads capacity, not a doomed retry. -->
                            <template v-else-if="hostedFull">
                                <p class="flex items-start gap-2 text-xs text-content">
                                    <Icon name="exclamation-circle" class="mt-0.5 shrink-0 text-warning" />
                                    <span>We're out of machines right now — every one we run is in use.</span>
                                </p>
                                <p class="text-xs leading-relaxed text-muted">
                                    Nothing to do with your account, and we're adding more. Setting it up on your own computer takes a couple of
                                    minutes and has no limits at all, or check back a little later and we'll have room.
                                </p>
                                <div class="flex flex-wrap items-center gap-3">
                                    <Button
                                        label="Set it up on my own computer"
                                        class="w-full justify-center md:w-fit"
                                        @click="chooseMachine(`mine`)"
                                    >
                                        <template #icon><Icon name="desktop" /></template>
                                    </Button>
                                    <button type="button" :class="ui.linkButton()" :disabled="hostedBusy" @click="recheckCapacity">
                                        Check again
                                    </button>
                                </div>
                            </template>
                            <template v-else>
                                <Button
                                    :label="hostedError ? `Try again` : `Start my machine`"
                                    class="w-full justify-center md:w-fit"
                                    :disabled="hostedSpent"
                                    @click="provisionHosted"
                                >
                                    <template #icon><Icon :name="hostedError ? `refresh` : `bolt`" /></template>
                                </Button>
                                <p class="text-xs leading-relaxed text-subtle">
                                    <template v-if="hostedSpent">
                                        You already have the free machine your account comes with. Pick another rung above, or delete the sandbox
                                        that's using it.
                                    </template>
                                    <template v-else>
                                        It sleeps while you're away and wakes when you come back. We don't back it up: turn on desktop sync, or keep
                                        your work in a git remote.<template v-if="hostedHours"> Unopened for a few weeks, it's removed.</template>
                                    </template>
                                </p>
                            </template>

                            <!-- Owed to a reader whose machine started unasked; reveals the rung, handed back only if actually chosen. -->
                            <nav
                                v-if="otherMachinesFolded"
                                aria-label="Other ways to set up"
                                class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"
                            >
                                <span>Other ways to set up:</span>
                                <button type="button" :class="ui.linkButton()" @click="showOtherMachines">Run it on my own computer</button>
                            </nav>
                        </template>

                        <!-- Hidden until the command's path is ready; a failed mint gets a notice and retry, not an endless placeholder. -->
                        <template v-else-if="!commandReady">
                            <template v-if="setupError">
                                <Notice :of="setupError" />
                                <Button label="Try again" class="w-full justify-center md:w-fit" @click="remint">
                                    <template #icon><Icon name="refresh" /></template>
                                </Button>
                            </template>
                            <!-- Theme's own placeholder surface (`ui-card-dashed`), not a hand-drawn dashed rectangle. -->
                            <div v-else class="ui-card ui-card-dashed flex items-start gap-2 rounded-none p-3 text-xs text-muted">
                                <Icon name="lock" class="mt-0.5 shrink-0" />
                                <span>{{ lockedReason }}</span>
                            </div>
                        </template>
                        <template v-else>
                            <!-- In the app the terminal is gone: one click hands the code to the app; the title already names the machine. -->
                            <template v-if="desktop">
                                <p class="text-xs text-muted">
                                    Installs Docker if you need it, starts your sandbox and its tunnel, and opens your workspace the moment it
                                    answers. No terminal.
                                </p>
                                <Button label="Set it up now" class="w-full justify-center md:w-fit" @click="runHere">
                                    <template #icon><Icon name="bolt" /></template>
                                </Button>
                            </template>

                            <!-- Browser's install-earlier answer, one button only; `w-fit` avoids a flex-column stretch `w-auto` doesn't stop. -->
                            <Button
                                v-if="appFirst && installer"
                                as="a"
                                :href="installer.href"
                                :label="`Download for ${installer.label}`"
                                class="w-full justify-center md:w-fit"
                                @click="onDownload"
                            >
                                <template #icon><Icon name="download" /></template>
                            </Button>

                            <!-- Phone's real next step, placed above the command it redirects from; a correction below goes unread. -->
                            <SetupHandoff v-if="mobile && created" :sandbox-id="created.id" :email="user?.email ?? ``" @sent="onEmailed" />

                            <!-- One row naming both alternatives by outcome, not stacked disclosures: one changes where, the other how. -->
                            <nav
                                v-if="desktop || mobile || appFirst || otherMachinesFolded"
                                aria-label="Other ways to set up"
                                class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"
                            >
                                <span>Other ways to set up:</span>
                                <!-- Only shown while the other rung is folded; the visible row already shows what a link here would offer. -->
                                <template v-if="otherMachinesFolded">
                                    <button type="button" :class="ui.linkButton()" @click="showOtherMachines">Use a machine we host</button>
                                    <span aria-hidden="true" class="text-subtle">·</span>
                                </template>
                                <button type="button" :class="ui.linkButton()" @click="showCommand = !showCommand">
                                    <template v-if="showCommand">Hide the command</template>
                                    <template v-else-if="desktop">Show the command for a server</template>
                                    <template v-else>Show the command</template>
                                </button>
                            </nav>

                            <div v-if="commandVisible" class="flex flex-col gap-2">
                                <!-- One line naming which machine, the one thing the title can't; skipped on a phone, already said there. -->
                                <p v-if="!mobile" class="flex items-center gap-2.5 text-xs text-muted">
                                    <Icon name="terminal" class="shrink-0 text-link" />
                                    <span class="min-w-0">
                                        <template v-if="desktop"
                                            >Copy it, then paste it into a terminal on the machine that will host your sandbox.</template
                                        >
                                        <template v-else>Paste it into a terminal: this computer, or any server you have a shell on.</template>
                                    </span>
                                </p>
                                <!-- Copy button rides the tab row on desktop, drops under the command on a phone: beside what it acts on. -->
                                <div class="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
                                    <SegmentedControl
                                        v-model="runTab"
                                        :options="runTabOptions"
                                        :stretch="mobile"
                                        class="[&>button]:py-1 [&>button]:text-xs"
                                    />
                                    <CopyButton
                                        v-if="!mobile && runTab !== `compose`"
                                        :text="selectedCommand"
                                        label="Copy"
                                        class="text-xs"
                                        @copied="onCopied"
                                    />
                                </div>
                                <SetupCompose v-if="runTab === `compose` && composeArgs" :args="composeArgs" />
                                <template v-else>
                                    <!-- Clamped on a phone: unwrapped runs many lines between Copy and the next step; no label, redundant already. -->
                                    <Code
                                        :code="selectedCommand"
                                        :lang="selectedCommandLang"
                                        :wrap="true"
                                        :copyable="false"
                                        :clamp-lines="mobile ? 4 : undefined"
                                    />
                                    <!-- Full width, touch-sized, under the command, since copying is the point; secondary, as the handoff is primary. -->
                                    <CopyButton
                                        v-if="mobile"
                                        :text="selectedCommand"
                                        label="Copy command"
                                        :stretch="true"
                                        severity="secondary"
                                        @copied="onCopied"
                                    />
                                    <!-- Local dev only, folded as a note to intentic's own devs; gated on the same condition as the tag it describes. -->
                                    <details v-if="buildsFromCheckout" class="text-xs text-warning">
                                        <summary class="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                                            <Icon name="box" class="shrink-0" />
                                            <span class="min-w-0">Local dev: builds from your checkout</span>
                                            <Icon name="chevron-down" class="shrink-0 text-subtle" />
                                        </summary>
                                        <p class="mt-1 pl-6">
                                            This command builds <code>{{ DEV_SANDBOX_IMAGE }}</code> from your checkout and runs that. Every run
                                            rebuilds, so sandbox edits are always picked up (cached when unchanged; the first build takes a few
                                            minutes). For a live edit loop, keep <code>pnpm dev:sandbox</code> running.
                                        </p>
                                    </details>
                                </template>
                            </div>

                            <!-- Sudo checkbox stays beside the command it rewrites, unix-only, and only while the command is on screen. -->
                            <div
                                v-if="environment.production && commandVisible && runTab === `unix`"
                                class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
                            >
                                <label class="flex cursor-pointer items-center gap-2">
                                    <Checkbox v-model="hasDocker" :binary="true" size="small" />
                                    <span class="shrink-0 text-content">I already have Docker</span>
                                </label>
                                <span class="min-w-0">
                                    <template v-if="hasDocker">Runs as you, no <code>sudo</code>.</template>
                                    <template v-else><code>sudo</code> is there for one job: installing Docker if it's missing.</template>
                                </span>
                            </div>

                            <!-- Sync for widths with no reference column; survives folding in the app, but not on the compose tab. -->
                            <SetupSyncOption v-if="syncOffered" v-model="syncEnabled" :folder="syncDir" class="xl:hidden" />
                        </template>

                        <!-- Spins in every state (the poll never stops); colour, not the spin, carries whose move it is. No 'Check now'. -->
                        <div v-if="waiting" class="flex flex-col gap-2">
                            <!-- Spinner doesn't survive a failure report; spinning beside 'here is what broke' would contradict itself. -->
                            <p
                                v-if="reportFailures === null"
                                class="flex items-center gap-2 text-xs"
                                :class="handoff === `claimed` ? `text-content` : `text-muted`"
                            >
                                <Icon
                                    name="spinner"
                                    spin
                                    class="shrink-0"
                                    :class="handoff === `claimed` ? `text-success` : handoff === `handed` ? `text-info` : `text-subtle`"
                                />
                                <span class="min-w-0">
                                    <!--
                                        Machine's own stage beats the canned guess; 'Starting Docker' was written before this page knew anything
                                        more.
                                    -->
                                    <template v-if="handoff === `claimed` && buildStage !== undefined">
                                        <span class="font-medium text-success">Your machine picked it up.</span> Right now: {{ buildStage }}.
                                    </template>
                                    <template v-else-if="handoff === `claimed`">
                                        <span class="font-medium text-success">Your machine picked it up.</span> Starting Docker. The first run takes
                                        a few minutes.
                                    </template>
                                    <!-- Handed off two ways, and the next move differs: a copied command still has to be
                                         pasted, where the app already has everything and is opening its own window.
                                         Once the app is reporting, the strip under this line is the answer and this
                                         line only names what is happening. -->
                                    <template v-else-if="handoff === `handed` && launched && desktopReport">
                                        <span class="font-medium text-content">The app is setting it up.</span> This page opens your workspace the
                                        moment it answers.
                                    </template>
                                    <template v-else-if="handoff === `handed` && launched">
                                        <span class="font-medium text-content">Handed to the app.</span> Follow it in the Intentic window. This page
                                        opens your workspace the moment it answers.
                                    </template>
                                    <template v-else-if="handoff === `handed`">
                                        <span class="font-medium text-content">Copied.</span> Paste it into that terminal and press Enter.
                                    </template>
                                    <!-- States whose move it is, not the sandbox's status ('nothing running' told the reader nothing actionable). -->
                                    <template v-else-if="desktop && !commandVisible">
                                        <span class="font-medium text-content">Waiting for you to start it.</span> Nothing runs until you press "Set
                                        it up now" above.
                                    </template>
                                    <!-- Same sentence for a browser offered an installer; naming the app's button would name one this reader lacks. -->
                                    <template v-else-if="installing">
                                        <span class="font-medium text-content">Waiting for you to start it.</span> Nothing runs until you install the
                                        app above.
                                    </template>
                                    <template v-else>
                                        <span class="font-medium text-content">Waiting for you to run the command.</span> We'll notice the moment your
                                        sandbox starts.
                                    </template>
                                </span>
                            </p>

                            <!-- THE APP'S OWN BAR, on this page: what "Back to your workspace" leaves behind. Only
                                 while this page handed the setup to the app (a report from a run some other tab
                                 started belongs to that tab's card), and only until the machine has reported in
                                 for itself, from which point the sandbox's own words above outrank the installer's. -->
                            <DesktopSetupProgress
                                v-if="launched && desktopReport && handoff !== `claimed`"
                                :report="desktopReport"
                                :heard-at="desktopHeardAt"
                            />

                            <!-- The machine said exactly what broke: render it verbatim, problem and fix per check,
                                 and the one instruction that is always true. This is the card the whole report
                                 channel exists for: the answer used to live in a terminal nobody was watching. -->
                            <Notice
                                v-if="reportFailures !== null"
                                :of="{ tone: `danger`, title: `Setup failed on your machine. Here is what it found:` }"
                            >
                                <ul class="mt-1.5 flex flex-col gap-1.5">
                                    <li v-for="failure in reportFailures" :key="failure.check" class="min-w-0 text-2xs">
                                        <span class="font-medium">{{ failure.check }}:</span> {{ failure.problem }}
                                        <span v-if="failure.remedy !== ``"> Fix: {{ failure.remedy }}</span>
                                    </li>
                                </ul>
                                <p class="mt-1.5 text-2xs">Fix the above, then run the same command again. It stays valid.</p>
                            </Notice>

                            <!-- Hidden on a wide screen, riding the reference column instead; at the foot it sat furthest from the command. -->
                            <SetupNudge
                                v-if="nudging"
                                class="xl:hidden"
                                :variant="nudgeVariant"
                                :stalled="stalled"
                                :command="selectedCommand"
                                :copyable="nudgeCopyable"
                                @copied="onCopied"
                            />

                            <!-- Claimed-but-silent differs from never-run: the command ran, so the terminal has the answer. Fuse is longer. -->
                            <p v-if="slowBuild" class="flex items-start gap-2 text-xs text-warning">
                                <Icon name="exclamation-circle" class="mt-0.5 shrink-0" />
                                <!-- Checks `launched`, not `commandVisible`: a folded command on a phone isn't sent to an app window it lacks. -->
                                <span class="min-w-0"
                                    >Picked up a while ago, still no sandbox. Check {{ launched ? `the Intentic window` : `that terminal` }} for an
                                    error. It's safe to re-run.</span
                                >
                            </p>
                        </div>
                        <p v-if="status" class="text-xs text-warning">{{ status }}</p>
                    </section>
                </div>

                <!--
                    Docked reference for the run step only; `xl:w-88` is measured to fit the longest cleanup one-liner on one
                    line, not a guess.
                -->
                <aside
                    v-if="created && lane === `provision` && laneTakeable && machine !== `hosted`"
                    class="hidden flex-col gap-3 xl:sticky xl:top-8 xl:flex xl:w-88 xl:shrink-0"
                >
                    <!-- Plain plate, no ornament: reference material isn't a decision, and corner elbows would claim otherwise. -->
                    <div class="entry-card flex flex-col gap-3 p-4">
                        <SetupRunDetails :cleanup="cleanupCommand" :downloads="!appFirst" />
                        <!-- Sync belongs with what the command does, not the path to it; gated on the command, like its twin under it. -->
                        <SetupSyncOption v-if="syncOffered" v-model="syncEnabled" :folder="syncDir" class="pt-1" />
                    </div>
                    <!-- Correction as this column's second card, once the wait reads as a misunderstanding, beside the command. -->
                    <SetupNudge
                        v-if="nudging"
                        :variant="nudgeVariant"
                        :stalled="stalled"
                        :command="selectedCommand"
                        :copyable="nudgeCopyable"
                        @copied="onCopied"
                    />
                </aside>
            </div>
        </div>
    </div>
</template>

<style scoped>
/*
 * Shared material lives in styles/entry.css (metals, ink, faces, plate, type). Below is this page's own
 * composition: how the art sits, the masthead, and this page's two objects, a rung and the framed card every
 * rung leads to.
 */

/*
 * The ground: how far the picture reaches, and where the veil closes over it. Both track the art (56.25vw, from
 * its own 16:9) rather than being chosen, with clamps at the extremes: a phone, where a fixed veil would close
 * over unpainted canvas, and a very wide monitor, where the masthead would float mid-temple.
 */
.vestibule .entry-plate {
    --plate-reach: clamp(16rem, 40vw, 34rem);
}
.vestibule .entry-veil {
    /* Held open to 5rem, closed by 13rem (the phone's case), so the picker always lands on canvas, not carving. */
    --veil-clear: clamp(5rem, 11vw, 9rem);
    --veil-hold: clamp(13rem, 34vw, 26rem);
}

/* The masthead: left down the working column, as the site sets every page but its home page. */
.masthead {
    padding-bottom: clamp(0.75rem, 2vw, 1.5rem);
}
.mast-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: clamp(1.5rem, 5vw, 2.75rem);
}
.mast-brand {
    font-size: 1.125rem;
}
/* Must not read as an action: the quiet tier already draws it right; this only aligns it with the mark opposite. */
.mast-back {
    font-size: 0.8125rem;
}
.mast-eyebrow {
    margin-bottom: 0.9rem;
}
.mast-headline {
    /* Sized between the door's headline and a page hero, since this one shares its screen with a decision. */
    font-family: var(--face-display);
    font-size: clamp(1.75rem, 4.6vw, 2.75rem);
    font-weight: 600;
    line-height: 1.24;
    text-wrap: balance;
}
.mast-lede {
    margin-top: 1rem;
    /* 56ch, not a rem cap, matches the site's character-counted columns (45-75); both lanes fit two lines. */
    max-width: 56ch;
    font-size: 1.0625rem;
    line-height: 1.6;
    color: #c2a077;
    text-wrap: pretty;
}

/*
 * Framed cards: `.entry-frame` draws the double rule and plate; padding lives here since it's the responsive
 * part and must clear the ornament. A body inset shallower than `--corner-size` puts a paragraph under a gold
 * curl.
 */
.work-card {
    padding: 1.6rem 1.35rem 1.35rem;
}
/* Finial sits astride the top rail; extra headroom above it, or the mark reads as belonging to neither card. */
.run-card {
    margin-top: 0.5rem;
    padding-top: 1.9rem;
}

/* Field name on the address row; small, spaced, gold, so it reads as a label, not a sentence on carved stone. */
.fact-label {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--gold);
}

/* `anywhere`, not `break-word`: a one-token hostname overran a 320px card; it breaks only whole words. */
.fact-host {
    overflow-wrap: anywhere;
}
@media (min-width: 48rem) {
    .work-card {
        padding: 1.9rem 1.75rem 1.75rem;
    }
    .run-card {
        padding-top: 2.25rem;
    }
}

/* A rung: one of three plaques on a shelf; the chosen one has its corners turned. */
.rung {
    /* Smaller than a frame's corner: reads as an elbow on a 200px card, not a bracket around it. */
    --corner-size: 1.25rem;

    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.3rem;
    padding: 1rem 1.1rem 1.1rem;
    text-align: left;
    cursor: pointer;
    border: 1px solid var(--rule);
    background: var(--plate);
    transition:
        border-color 0.22s ease,
        background-color 0.22s ease,
        box-shadow 0.22s ease,
        transform 0.22s ease;
}
.rung:hover:not(:disabled) {
    border-color: var(--rule-strong);
    background: #191309;
}
.rung:disabled {
    cursor: not-allowed;
    opacity: 0.6;
}
/* In the markup on all three (never resizing the box); only the chosen rung's corners are painted, not present. */
.rung .entry-corner {
    opacity: 0;
    transition: opacity 0.22s ease;
}
.rung-on .entry-corner {
    opacity: 0.95;
}
.rung-on {
    border-color: var(--gold);
    background: #1c150c;
    /* A hairline outside the first adds weight without resizing; the shadow lifts it off the others' shelf. */
    box-shadow:
        0 0 0 1px rgba(201, 160, 92, 0.22),
        0 18px 40px -24px rgba(0, 0, 0, 0.9);
    transform: translateY(-1px);
}
.rung-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.35rem;
    font-family: var(--face-mark);
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.2;
    color: var(--ink);
}
.rung-name .entry-lozenge {
    width: 0.5rem;
    height: 0.5rem;
    color: var(--ink-subtle);
    transition: color 0.22s ease;
}
/* Second of the page's three ember spends: a glow mark, not a fill, the whole difference between chosen and not. */
.rung-on .rung-name {
    color: var(--gold-bright);
}
.rung-on .rung-name .entry-lozenge {
    color: var(--ember);
    filter: drop-shadow(0 0 5px rgba(224, 123, 39, 0.9)) drop-shadow(0 0 12px rgba(224, 123, 39, 0.55));
}
.rung-cost {
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--gold);
}
</style>
