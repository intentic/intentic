<script setup lang="ts">
import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { sandboxSubdomain } from "@intentic/sandbox-contract";
import {
    AppBrand,
    Button,
    Code,
    ConfirmDialog,
    CopyButton,
    InfoHint,
    Notice,
    SegmentedControl,
    StepSection,
    ui,
    useDevice,
    useOsPreference,
    vAction,
} from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { desktopVersion, openDesktopLink } from "../../app/environments/desktop";
import { desktopInstaller } from "../../app/environments/desktopDownloads";
import { environment } from "../../app/environments/environment";
import { apiClient } from "../../lib/useApi";
import { revealConversation } from "../agents/fleet/agentActions";
import { useAuth } from "../auth/useAuth";
import { useGoogleIdentity } from "../auth/useGoogleIdentity";
import CloudflareTokenField from "../capabilities/connect/CloudflareTokenField.vue";
import { composingConversation } from "../chat/panel/useChat-reveal";
import { useCloudflareZones } from "../extensions/useCloudflareZones";
import { useSandbox } from "../sandbox/client/useSandbox";
import { sandboxIdFromToken } from "../sandbox/session/sandboxIdFromToken";
import DesktopSetupProgress from "./DesktopSetupProgress.vue";
import { useDesktopSetup } from "./desktopSetup";
import SetupCompose from "./SetupCompose.vue";
import SetupHandoff from "./SetupHandoff.vue";
import SetupNudge from "./SetupNudge.vue";
import SetupRunDetails from "./SetupRunDetails.vue";
import SetupRungArt from "./SetupRungArt.vue";
import SetupSyncOption from "./SetupSyncOption.vue";
import { probeDaemon } from "./setupAttach";
import { lockedReasonOf } from "./flow/commandHandoff";
import { DEV_SANDBOX_IMAGE } from "./flow/installCommand";
import { ladderOptionsOf } from "./flow/machineLadder";
import { useAttachLane } from "./flow/useAttachLane";
import { useCommandLane } from "./flow/useCommandLane";
import { useCommandWait } from "./flow/useCommandWait";
import { useHostedLane } from "./flow/useHostedLane";
import { useRegistryWatch } from "./flow/useRegistryWatch";
import { useRunStep } from "./flow/useRunStep";
import { useSetupArrival } from "./flow/useSetupArrival";
import { useSetupRow } from "./flow/useSetupRow";

// Template and wiring over the setup flows in ./flow: the row this visit sets up, the hosted lane and the command lane
// that both provision onto it (the attach lane records an already-reachable domain instead), the arrival that picks one
// of them unasked, and the registry watch that opens the workspace. What each decides is stated where it is decided.

const t = useT();
const sandbox = useSandbox();
const router = useRouter();
const route = useRoute();
const { mobile } = useDevice();
const { user } = useAuth();
const { getIdToken, warmIdToken } = useGoogleIdentity();
// The preferred shell, a persisted singleton shared across screens.
const { cmdOs } = useOsPreference();
const { report: desktopReport, heardAt: desktopHeardAt } = useDesktopSetup();
// Token and zone discovery shared with useCloudflareZones; it feeds only the command, never .env.
const cf = useCloudflareZones();
const { cfToken, cfTokenValid, selectedZone, zonesLoading, zonesError } = cf;

// Which spine step 1 heads: `provision` (run, wait) or `attach` (a reachable domain); both share the row.
const lane = ref<`provision` | `attach`>(`provision`);
// Reachability: `intentic` is zero-config, `own` brings the reader's own Cloudflare zone.
const mode = ref<`intentic` | `own`>(`intentic`);
// One disclosure for both ways off the default address: a Cloudflare zone, or an already-answering domain.
const reaching = ref(false);
// An editable subdomain prefix, pre-filled with the derived `sandbox-<hash>`; the hostname is `<subdomain>.<zone>`.
const subdomain = ref(``);
const derivedPrefix = ref(``);
const subdomainValid = computed(() => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(subdomain.value.trim()));
const desktop = computed(() => desktopVersion() !== undefined);
// The installer replaces the raw pipe where a build ships for this machine; undefined leaves the pipe.
const installer = computed(() => (desktop.value || mobile.value ? undefined : desktopInstaller()));
const reader = { mobile, inApp: desktop, installer };

// Lands on `/`, which differs by form factor (a phone has no docked chat, so it opens straight into one).
const enterWorkspace = async (): Promise<void> => {
    await router.push(`/`);
    revealConversation(composingConversation());
};

const row = useSetupRow({ sandbox, enter: enterWorkspace });
const { created, resuming, finished, creating, error, claimedAt, report, announced, autoCreate } = row;
const hosted = useHostedLane({ platform: apiClient.sandbox, sandbox, row });
const {
    machine,
    hostedRow,
    hostedOffer,
    hostedOffered,
    hostedSpent,
    hostedSuspended,
    hostedFull,
    hostedHours,
    hostedHost,
    hostedBusy,
    releasingHosted,
    hostedError,
    hostedWait,
    handBackAsked,
    provisionHosted,
    restartHosted,
    recheckCapacity,
    chooseMachine,
    confirmHandBack,
} = hosted;
const command = useCommandLane({ platform: apiClient.sandbox, row, hosted, lane });
const { intenticAvailable, addressed, addressless, setup, setupError, commandReady, copied, launched, remint } = command;
const step = useRunStep({ command, row, reader, cmdOs, mode, cfToken, openDesktopLink });
const {
    runTab,
    runTabOptions,
    showCommand,
    hasDocker,
    syncEnabled,
    appFirst,
    commandVisible,
    installing,
    retriedByButton,
    syncDir,
    syncOffered,
    buildsFromCheckout,
    webOrigin,
    selectedCommand,
    selectedCommandLang,
    cleanupCommand,
    composeArgs,
    runHere,
} = step;
const wait = useCommandWait({ command, row, step, reader, desktopReport });
const { emailed, handoff, reportFailures, buildStage, nudging, stalled, nudgeVariant, nudgeCopyable, slowBuild, onCopied, onEmailed, onDownload } =
    wait;
const attach = useAttachLane({ sandbox, row, minted: () => setup.value?.hostname, getIdToken, probe: probeDaemon });
const { domain, attachToken, attaching, attachOutcome, originHelp, normalizedDomain, ownAddress, domainProblem, connectDomain } = attach;
const { status } = useRegistryWatch({ sandbox, row, hosted, mintedFor: command.mintedFor });

// Another sandbox to go back to: not this one, and not one that has never reported in.
const otherWorkspace = computed(() => sandbox.sandboxes.value.some((entry) => entry.id !== created.value?.id && entry.lastSeenAt !== null));
// Reconnecting a sandbox that has run before reads differently from resuming one that never started.
const neverStarted = computed(() => created.value !== null && created.value.lastSeenAt === null);
// Whether a provision lane exists (a machine or an address); without either, attach is the whole flow, not a detour.
const provisionOffered = computed(() => addressed.value || hostedOffered.value);
const ladderOptions = computed(() =>
    ladderOptionsOf({
        hostedOffered: hostedOffered.value,
        hostedFull: hostedFull.value,
        hostedSuspended: hostedSuspended.value,
        plan: hostedOffer.value?.plan === true,
        hours: hostedHours.value,
        // The command redeems a setup code, so it is offered only where addresses are, even in the app.
        commandOffered: addressed.value,
        installer: installer.value,
    }),
);

// The hosted lane's one silent attempt at the browser's sandbox credential while the reader watches the machine boot;
// a full sign-in gate here would ask for a second sign-in before anything even runs.
const warmSandboxCredential = async (): Promise<void> => {
    await warmIdToken();
    if ((await getIdToken({ interactive: false })) === undefined) {
        await getIdToken({ silent: true });
    }
};

const {
    arrival,
    elsewhere,
    loaded,
    lanes,
    laneTakeable,
    readArrival,
    forget: forgetArrival,
} = useSetupArrival({
    sandbox,
    platform: apiClient.sandbox,
    row,
    hosted,
    command,
    route,
    inApp: desktop,
    ladder: ladderOptions,
    warmCredential: warmSandboxCredential,
    runHere,
});

// The picker is on screen when the arrival could answer nothing for itself, or when the reader asked for it; one rung
// is not a picker, so it takes a real choice. The untaken rung folds behind a link off the same facts.
const elsewhereOffered = computed(() => arrival.value === `choose` || elsewhere.value);
const ladderShown = computed(() => elsewhereOffered.value && ladderOptions.value.length > 1);
const otherMachinesFolded = computed(() => !elsewhereOffered.value && ladderOptions.value.length > 1);
// The reveal link sits under the card while the rungs appear above it, so the page scrolls to them.
const ladderRow = ref<HTMLElement | null>(null);
const showOtherMachines = async (): Promise<void> => {
    elsewhere.value = true;
    await nextTick();
    ladderRow.value?.scrollIntoView({ behavior: `smooth`, block: `center` });
};

// Which address the card reports: the hosted machine's own, none minted, the intentic default, or the reader's zone.
const addressFact = computed<`hosted` | `none` | `intentic` | `own`>(() =>
    machine.value === `hosted` ? `hosted` : addressless.value ? `none` : mode.value === `intentic` ? `intentic` : `own`,
);
// The address row's quiet label, styled as a band opener rather than body copy; values sit on its baseline, in mono
// only for a real hostname.
const factLabel = `fact-label shrink-0`;
const factSlot = `flex min-w-0 items-baseline text-sm text-content`;
const factHost = `${factSlot} fact-host font-mono`;

const lockedReason = computed(() =>
    lockedReasonOf({
        addressless: addressless.value,
        mode: mode.value,
        mintError: setupError.value?.title,
        cfToken: cfToken.value,
        cfTokenValid: cfTokenValid.value,
        zonesLoading: zonesLoading.value,
        zonesError: zonesError.value,
        zone: selectedZone.value,
        subdomainValid: subdomainValid.value,
    }),
);

// Flips which lane step 1 heads; nothing is carried across, a half-finished attach included, and the chooser that
// offered the lane has been answered.
const setLane = (next: `provision` | `attach`): void => {
    lane.value = next;
    attach.resetAttach();
    error.value = null;
    reaching.value = false;
};

// The chooser's other answer: provision under the reader's own Cloudflare zone, a form rather than a lane.
const chooseOwnZone = (): void => {
    mode.value = `own`;
    reaching.value = false;
};

// The draft rule: the row made on arrival is a draft until an act commits it, never a guess from elapsed time. The
// command copied, mailed or handed to the app; a machine of ours on it; a code redeemed or a run reported; a check-in.
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

// Forgets the row on screen for a new one, and everything derived from it; the old row is discarded as leaving would.
const startFresh = (): void => {
    row.discardDraft(committed.value);
    row.forget();
    command.forget();
    forgetArrival();
    // An abandoned hosted sandbox keeps existing; the fresh one starts on the own-computer rung.
    hosted.hostedSince.value = undefined;
    machine.value = `mine`;
    subdomain.value = ``;
    derivedPrefix.value = ``;
    domain.value = ``;
    attach.resetAttach();
    // Dropping ?sandbox= keeps a reload from resuming the abandoned row.
    void router.replace({ path: `/setup` });
    void autoCreate();
};

// Names the settled row in the URL, so the page survives a reload onto it: without it the arrival re-derives a row, and
// its fallback is to create one, leaving a second sandbox while the first still pulls its image. A replace, since the
// reader took no navigation step.
watch(
    () => created.value?.id,
    (id) => {
        if (id === undefined || route.query[`sandbox`] === id) {
            return;
        }
        void router.replace({ path: `/setup`, query: { ...route.query, sandbox: id } });
    },
    { immediate: true },
);

// Derives the default `sandbox-<hash>` prefix (as the CLI does), pre-filling a subdomain nobody has typed. The owner's
// row carries its token; a member's null one never reaches this page.
watch(
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

// Warms the browser's sandbox credential once, the moment a command is ready, silently only.
let credentialWarmed = false;
watch(commandReady, (ready) => {
    if (ready && !credentialWarmed) {
        credentialWarmed = true;
        void warmIdToken();
    }
});

onMounted(readArrival);
// Leaving without committing discards the draft: the only exit hook, since beforeunload cannot hold a round trip.
onUnmounted(() => row.discardDraft(committed.value));
</script>

<template>
    <!-- dvh not vh: a phone's collapsing chrome makes 100vh taller than the screen, hiding the last step. -->
    <div class="entry vestibule w-full overflow-auto">
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
                        :label="t(`setup.setup.backToWorkspace`)"
                        severity="secondary"
                        :text="true"
                        class="mast-back shrink-0"
                    >
                        <template #icon><Icon name="arrow-left" /></template>
                    </Button>
                </div>

                <!-- One sentence only; the door's headline gets two, but here the loudest thing on screen has to be a rung. -->
                <h1 class="mast-headline">
                    <span class="entry-display">{{ t(`setup.setup.setUpWorkspace`) }}</span
                    ><span class="entry-stop">.</span>
                </h1>

                <!-- Lede must match the lane and ask a question only when the picker actually shows, keyed on `ladderShown`. -->
                <p class="mast-lede">
                    <template v-if="lane === `attach`">{{ t(`setup.setup.pointIntenticAtSandbox`) }}</template>
                    <!-- Nothing to start, so no promised minute or two; reads the same verdict the card below does. -->
                    <template v-else-if="loaded && !laneTakeable">{{ t(`setup.setup.heresWhatPlatformDo`) }}</template>
                    <template v-else-if="ladderShown">{{ t(`setup.setup.pickWhereRunsYoull`) }}</template>
                    <template v-else-if="machine === `hosted`">{{ t(`setup.setup.startingMachineYoullWorking`) }}</template>
                    <template v-else-if="desktop">{{ t(`setup.setup.settingUpOnComputer`) }}</template>
                    <!-- One rung, no picker, nothing started yet; names the lane without claiming work that hasn't begun. -->
                    <template v-else>{{ t(`setup.setup.runsOnComputerYours`) }}</template>
                </p>
            </header>

            <!-- Two columns from xl (steps + docked panel); below that, one column and the panel folds into step 2's (i) hint. -->
            <div class="flex flex-col gap-3 md:gap-4 xl:flex-row xl:items-start xl:gap-6">
                <div class="flex min-w-0 flex-1 flex-col gap-3 md:gap-4 xl:max-w-3xl">
                    <!-- Titled since it asks for something (a form needs a heading); an icon, not a number, since there's no step 2. -->
                    <StepSection
                        v-if="lane === `attach`"
                        icon="link"
                        :title="t(`setup.setup.connectSandbox`)"
                        class="entry-frame rounded-none work-card"
                    >
                        <!-- The lane's corners are positioned against the shared entry frame. -->
                        <span class="entry-corner entry-corner-tl"></span>
                        <span class="entry-corner entry-corner-tr"></span>
                        <span class="entry-corner entry-corner-bl"></span>
                        <span class="entry-corner entry-corner-br"></span>
                        <!-- Explains why the page (not the reader) chose this lane; else 'give us your domain' reads as a missing step. -->
                        <p v-if="!provisionOffered" class="flex items-start gap-2 text-xs text-muted">
                            <Icon name="info-circle" class="mt-0.5 shrink-0" />
                            <span>{{ t(`setup.setup.platformDoesntStartSandboxes`) }}</span>
                        </p>
                        <p class="text-xs text-muted">
                            {{ t(`setup.setup.alreadyRunningSandboxContainer`) }}
                        </p>
                        <label class="ui-field">
                            <span class="ui-field-label">{{ t(`shared.domain`) }}</span>
                            <!-- Stack the domain field on phones so its address remains readable. -->
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
                                <!-- Attaching disables the action as well as showing progress. -->
                                <Button
                                    :label="t(`ui.action.connect`)"
                                    class="w-full justify-center md:w-fit"
                                    :loading="attaching"
                                    :disabled="attaching || normalizedDomain === undefined || ownAddress !== undefined"
                                    @click="connectDomain"
                                >
                                    <template #icon><Icon name="link" /></template>
                                </Button>
                            </div>
                            <span v-if="domainProblem" class="text-xs text-warning">{{ domainProblem }}</span>
                            <span v-else-if="normalizedDomain" class="text-xs text-muted"
                                >{{ t(`setup.setup.wellConnectTo`) }} <span>{{ normalizedDomain }}</span
                                >.</span
                            >
                            <span v-else class="text-xs text-muted">{{ t(`setup.setup.httpsAddressSandboxAlready`) }}</span>
                        </label>

                        <!-- Each probe failure names the one thing the user can do about it. -->
                        <!-- Two checks anyone can make, then the one that needs a variable they may never have set: a
                             reader who has not heard of WEB_ORIGIN reads it as a fourth thing wrong with their setup. -->
                        <Notice v-if="attachOutcome?.kind === `unreachable`" :of="{ tone: `danger`, title: `Nothing answered at that address.` }">
                            <span class="mt-0.5 block text-2xs">{{ t(`setup.setup.checkSandboxRunningDomain`) }}</span>
                            <!-- A button rather than <details>: Notice's slot lives inside a <span>, which takes phrasing
                                 content only, and this page already folds by toggle everywhere else. -->
                            <button v-if="!originHelp" type="button" :class="ui.linkButton(`mt-1 text-2xs`)" @click="originHelp = true">
                                {{ t(`setup.setup.checkedBothStillNothing`) }}
                            </button>
                            <span v-else class="mt-1 block text-2xs">
                                {{ t(`setup.setup.daemonsWebOrigin`) }} <code>WEB_ORIGIN</code> {{ t(`setup.setup.alsoToName`) }}
                                <span>{{ webOrigin ?? PLATFORM_WEB_ORIGIN }}</span
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
                        <!-- A live tunnel without a sandbox reports the missing sandbox. -->
                        <Notice
                            v-else-if="attachOutcome?.kind === `no-origin`"
                            :of="{ tone: `danger`, title: `That domain is live, but no sandbox is running behind it.` }"
                        >
                            <span class="mt-0.5 block text-2xs">
                                {{ t(`setup.setup.tunnelReverseProxyAnswered`) }} {{ attachOutcome.status }} {{ t(`setup.setup.nothingToForwardTo`)
                                }}<template v-if="created !== null">{{ t(`setup.setup.getDomainIntenticRun`) }}</template
                                >.
                            </span>
                        </Notice>
                        <template v-else-if="attachOutcome?.kind === `needs-token`">
                            <Notice :of="{ tone: `warning`, title: `Your sandbox is up, but it wouldn't let us in yet.` }">
                                <span class="mt-0.5 block text-2xs"
                                    >{{ t(`setup.setup.waitingToClaimedConnection`) }} <code>CONNECT_TOKEN</code>
                                    {{ t(`setup.setup.toClaimYours`) }}</span
                                >
                            </Notice>
                            <label class="ui-field">
                                <span class="ui-field-label">{{ t(`setup.setup.connectionToken`) }}</span>
                                <input
                                    v-model="attachToken"
                                    type="password"
                                    autocomplete="off"
                                    autocapitalize="off"
                                    spellcheck="false"
                                    :placeholder="t(`setup.setup.connectTokenSandboxRuns`)"
                                    :class="ui.input('w-full')"
                                    @keydown.enter="connectDomain"
                                />
                                <span class="text-xs text-muted">
                                    {{ t(`setup.setup.usedOnceToClaim`) }}
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
                            {{ created === null ? t(`setup.setup.setOneUpMe`) : t(`setup.setup.getDomainIntenticInstead`) }}
                        </button>
                    </StepSection>

                    <!-- Naming lives inside the workspace; this space holds only exceptional arrival state, before the machine choice. -->
                    <!-- Renders only before `created` exists (or a resumed row); `!loaded` alone once drew this beside the run card. -->
                    <div v-else-if="created === null || resuming" class="flex flex-col items-start gap-2 py-1">
                        <template v-if="created === null">
                            <!-- Offers and row creation render as one loading state. -->
                            <p v-if="!loaded || creating" class="flex items-center gap-2 text-xs text-muted">
                                <Icon name="spinner" spin class="text-info" />
                                {{ t(`setup.setup.settingOneUpNothing`) }}
                            </p>
                            <template v-else>
                                <Notice v-if="error" :of="error" />
                                <Button :label="t(`ui.action.tryAgain`)" class="w-full justify-center md:w-fit" @click="autoCreate">
                                    <template #icon><Icon name="refresh" /></template>
                                </Button>
                            </template>
                            <!-- Attach is offered only after platform capabilities load. -->
                            <button v-if="loaded" type="button" :class="ui.linkButton()" @click="setLane(`attach`)">
                                {{ t(`setup.setup.alreadyRunningSandboxSomewhere`) }}
                            </button>
                        </template>
                        <p v-else class="text-xs text-muted">
                            {{ neverStarted ? t(`setup.setup.pickingUpWhereLeft`) : t(`setup.setup.stillOnPlatformCleanup`) }}
                            <button type="button" class="cursor-pointer text-link hover:underline" @click="startFresh">
                                {{ t(`setup.setup.useNewSandboxInstead`) }}</button
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
                            <Button :label="t(`ui.action.tryAgain`)" class="w-full justify-center md:w-fit" @click="readArrival">
                                <template #icon><Icon name="refresh" /></template>
                            </Button>
                        </template>
                        <!-- Show the remedy only when a reported-in sandbox can receive it. -->
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
                            {{ t(`setup.setup.alreadyRunningSandboxSomewhere`) }}
                        </button>
                    </div>

                    <!-- Card is what you do (command, two switches, one state line); what it means moved to SetupRunDetails, docked or folded into (i). -->

                    <!-- No heading: it could only name one of three answers below, and the chooser says it better than a title could. -->
                    <!-- Ladder is its own row outside every card, not nested in the run card, so it isn't read as a step's detail. -->
                    <div v-if="created && lane === `provision` && ladderShown" ref="ladderRow" class="flex flex-col gap-2">
                        <!-- One column per rung, so two rungs are two halves, not two thirds of a row with a hole for the third. -->
                        <div
                            class="grid gap-3"
                            :class="ladderOptions.length === 2 ? `sm:grid-cols-2` : `sm:grid-cols-3`"
                            role="radiogroup"
                            :aria-label="t(`setup.setup.whereSandboxRuns`)"
                        >
                            <!-- Selected rungs use gold corners as the page's selection signal. -->
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
                                <!-- The rung art reserves space while its spinner is shown. -->
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
                                <!-- The mark stays on the title line so the rung reads as one station. -->
                                <span class="rung-name">
                                    <span class="entry-lozenge"></span>
                                    <span class="min-w-0">{{ option.title }}</span>
                                </span>
                                <!-- Cost gets its own colour: the one line a reader compares across the row rather than reading down. -->
                                <span class="rung-cost">{{ option.meta }}</span>
                                <!-- Keep the rung note to a short action or destination. -->
                                <span class="text-xs leading-snug text-subtle">{{ option.note }}</span>
                                <!-- Spent allowances remain visible instead of hiding an unavailable rung. -->
                                <span v-if="option.value === `hosted` && hostedSpent" class="text-xs text-warning">{{
                                    hostedSuspended ? t(`setup.setup.notAvailableToAccount`) : t(`setup.setup.alreadyUsingYours`)
                                }}</span>
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
                        <!-- The card lead keeps references such as “the token above” visible. -->
                        <div class="flex flex-col gap-2">
                            <!-- One group keeps the escape hatch reachable in every state. -->
                            <!-- Stacked on a phone: a label column left too little room for a hostname, read character by character. -->
                            <div
                                v-if="addressFact !== `own`"
                                class="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 sm:min-h-8 sm:grid-cols-facts sm:content-center sm:items-baseline"
                            >
                                <span :class="factLabel">{{ t(`shared.address`) }}</span>
                                <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                                    <!-- Address facts are keyed by the selected rung, not machine state. -->
                                    <template v-if="addressFact === `hosted`">
                                        <span v-if="hostedHost" :class="factHost">{{ hostedHost }}</span>
                                        <span v-else-if="hostedRow !== null" :class="`${factSlot} gap-2 text-xs text-muted`">
                                            <Icon name="spinner" spin class="self-center" /> {{ t(`setup.setup.assignedMachineStarts`) }}
                                        </span>
                                        <!-- A missing machine must not produce an address promise. -->
                                        <span v-else :class="`${factSlot} text-xs text-muted`">{{
                                            hostedFull ? t(`setup.setup.assignedMachineFreesUp`) : t(`setup.setup.assignedMachineStarts2`)
                                        }}</span>
                                    </template>
                                    <!-- A platform without addresses shows a fact, not a waiting state. -->
                                    <span v-else-if="addressFact === `none`" :class="`${factSlot} text-xs text-muted`">
                                        {{ t(`setup.setup.platformDoesntSetOne`) }}
                                    </span>
                                    <template v-else>
                                        <!-- `.title`: interpolating the NoticeModel itself would render its JSON. -->
                                        <span v-if="setupError" :class="`${factSlot} text-xs text-danger`">{{ setupError.title }}</span>
                                        <span v-else-if="setup" :class="factHost">{{ setup.hostname }}</span>
                                        <span v-else :class="`${factSlot} gap-2 text-xs text-muted`">
                                            <Icon name="spinner" spin class="self-center" /> {{ t(`setup.setup.preparingIntenticDomain`) }}
                                        </span>
                                        <!-- One escape hatch presents the available choices. -->
                                        <button type="button" :class="ui.linkButton()" @click="reaching = !reaching">
                                            {{ reaching ? t(`setup.setup.keepAddress`) : t(`setup.setup.useDifferentAddress`) }}
                                        </button>
                                    </template>
                                </div>
                            </div>

                            <!-- Address overflow uses labels instead of a nested bordered panel. -->
                            <p v-if="addressFact === `none`" class="text-xs text-muted">
                                {{ t(`setup.setup.sandboxesHereReachedAt`) }}
                                <button type="button" class="cursor-pointer text-link hover:underline" @click="setLane(`attach`)">
                                    {{ t(`setup.setup.connectDomainAnswersOn`) }}</button
                                >.
                            </p>
                            <p v-else-if="addressFact === `intentic` && reaching" class="text-xs text-muted">
                                {{ t(`setup.setup.use`) }}
                                <button type="button" class="cursor-pointer text-link hover:underline" @click="chooseOwnZone">
                                    {{ t(`setup.setup.ownCloudflareZone`) }}</button
                                >{{ t(`setup.setup.connect`) }}
                                <button type="button" class="cursor-pointer text-link hover:underline" @click="setLane(`attach`)">
                                    {{ t(`setup.setup.domainAlreadyAnswersOn`) }}</button
                                >.
                            </p>

                            <!-- Own Cloudflare credentials and the way back share this section. -->
                            <template v-if="addressFact === `own`">
                                <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                    <button v-if="intenticAvailable" type="button" :class="ui.linkButton()" @click="mode = `intentic`">
                                        {{ t(`setup.setup.useIntenticsDomain`) }}
                                    </button>
                                    <InfoHint :label="t(`views.words.whyCloudflareApiToken`)">
                                        <p class="mb-1 text-sm font-medium text-content">{{ t(`views.words.whyToken`) }}</p>
                                        <p class="mb-3 text-xs leading-relaxed text-muted">
                                            {{ t(`setup.setup.intenticReachesSandboxOver`) }}
                                        </p>
                                        <ul class="flex flex-col gap-2 text-xs text-muted">
                                            <li class="flex items-start gap-2">
                                                <Icon name="bolt" class="mt-0.5 text-link" />
                                                <span
                                                    >{{ t(`setup.setup.letsInstallCommand`) }}
                                                    <span class="text-content">{{ t(`setup.setup.createTunnel`) }}</span></span
                                                >
                                            </li>
                                            <li class="flex items-start gap-2">
                                                <Icon name="lock" class="mt-0.5 text-success" />
                                                <span
                                                    ><span class="text-content">{{ t(`setup.setup.neverStoredByIntentic`) }}</span
                                                    >{{ t(`setup.setup.usedOnceToList`) }}</span
                                                >
                                            </li>
                                        </ul>
                                    </InfoHint>
                                </div>
                                <CloudflareTokenField
                                    :cf="cf"
                                    storage-note="Used once to look up your Cloudflare zones, then it rides the command into your sandbox, never stored by intentic."
                                />

                                <!-- The zone suffix wraps so the subdomain keeps phone width. -->
                                <label v-if="selectedZone" class="ui-field">
                                    <span class="ui-field-label">{{ t(`shared.domain`) }}</span>
                                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                        <input
                                            :value="subdomain"
                                            @input="subdomain = ($event.target as HTMLInputElement).value"
                                            autocomplete="off"
                                            autocapitalize="off"
                                            spellcheck="false"
                                            :placeholder="t(`setup.setup.sandbox`)"
                                            :class="ui.input('w-full md:w-auto md:min-w-0 md:flex-1')"
                                        />
                                        <span class="text-sm break-words text-subtle">.{{ selectedZone }}</span>
                                    </div>
                                    <span v-if="!subdomainValid" class="text-xs text-warning">{{ t(`setup.words.useLettersNumbersHyphens`) }}</span>
                                    <span v-else class="text-xs text-success"
                                        >{{ t(`setup.setup.sandboxReachableAt`) }}
                                        <span class="break-words">{{ subdomain.trim() }}.{{ selectedZone }}</span
                                        >.</span
                                    >
                                </label>
                            </template>
                        </div>

                        <!-- Kept separate from the arrival notice so a lane change doesn't erase it; a full fleet isn't shown twice. -->
                        <Notice v-if="hostedError && !hostedFull" :of="hostedError" />

                        <!-- Show progress steps or the failure, never both. -->
                        <template v-if="machine === `hosted`">
                            <template v-if="hostedRow !== null">
                                <!-- Failure state replaces the progress list. -->
                                <template v-if="hostedWait.failure">
                                    <p class="flex items-start gap-2 text-xs text-content">
                                        <Icon name="exclamation-circle" class="mt-0.5 shrink-0 text-warning" />
                                        <span>{{ hostedWait.failure.problem }}</span>
                                    </p>
                                    <p class="text-xs text-muted">{{ hostedWait.failure.remedy }}</p>
                                    <!-- Starting it over is offered only where it can work: after a refused start, the one button
                                         that cannot help is the one asking for another. -->
                                    <Button
                                        v-if="hostedWait.failure.action !== `none`"
                                        :label="t(`setup.setup.startOver`)"
                                        class="w-full justify-center md:w-fit"
                                        :disabled="hostedBusy"
                                        @click="restartHosted"
                                    >
                                        <template #icon><Icon name="refresh" /></template>
                                    </Button>
                                    <Button
                                        v-else
                                        :label="t(`setup.setup.setUpOnMy`)"
                                        class="w-full justify-center md:w-fit"
                                        @click="chooseMachine(`mine`)"
                                    >
                                        <template #icon><Icon name="desktop" /></template>
                                    </Button>
                                </template>
                                <!-- Healthy waits show one row per step and spin the current row. -->
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
                                    <!-- The wait note uses the origin estimate and elapsed time. -->
                                    <p class="text-xs text-muted">{{ hostedWait.note }}</p>
                                </template>
                            </template>
                            <p v-else-if="hostedBusy" class="flex items-center gap-2 text-xs text-content">
                                <Icon name="spinner" spin class="text-info" />
                                {{ t(`setup.setup.startingMachine`) }}
                            </p>
                            <!-- The action states the no-backup commitment at the decision point. -->
                            <!-- A full fleet offers only a capacity recheck. -->
                            <template v-else-if="hostedFull">
                                <p class="flex items-start gap-2 text-xs text-content">
                                    <Icon name="exclamation-circle" class="mt-0.5 shrink-0 text-warning" />
                                    <span>{{ t(`setup.setup.outMachinesRightNow`) }}</span>
                                </p>
                                <p class="text-xs leading-relaxed text-muted">
                                    {{ t(`setup.setup.nothingToDoAccount`) }}
                                </p>
                                <div class="flex flex-wrap items-center gap-3">
                                    <Button :label="t(`setup.setup.setUpOnMy`)" class="w-full justify-center md:w-fit" @click="chooseMachine(`mine`)">
                                        <template #icon><Icon name="desktop" /></template>
                                    </Button>
                                    <button type="button" :class="ui.linkButton()" :disabled="hostedBusy" @click="recheckCapacity">
                                        {{ t(`ui.action.checkAgain`) }}
                                    </button>
                                </div>
                            </template>
                            <template v-else>
                                <Button
                                    :label="hostedError ? t(`ui.action.tryAgain`) : t(`setup.setup.startMyMachine`)"
                                    class="w-full justify-center md:w-fit"
                                    :disabled="hostedSpent"
                                    @click="provisionHosted"
                                >
                                    <template #icon><Icon :name="hostedError ? `refresh` : `bolt`" /></template>
                                </Button>
                                <p class="text-xs leading-relaxed text-subtle">
                                    <template v-if="hostedSuspended">
                                        {{ t(`setup.setup.hostedSandboxesSwitchedOff`) }}
                                    </template>
                                    <template v-else-if="hostedSpent">
                                        {{ t(`setup.setup.alreadyFreeMachineAccount`) }}
                                    </template>
                                    <template v-else>
                                        {{ t(`setup.setup.sleepsWhileYoureAway`)
                                        }}<template v-if="hostedHours"> {{ t(`setup.setup.unopenedFewWeeksRemoved`) }}</template>
                                    </template>
                                </p>
                            </template>

                            <!-- Owed to a reader whose machine started unasked; reveals the rung, handed back only if actually chosen. -->
                            <nav
                                v-if="otherMachinesFolded"
                                :aria-label="t(`setup.setup.otherWaysToSet`)"
                                class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"
                            >
                                <span>{{ t(`setup.setup.otherWaysToSet2`) }}</span>
                                <button type="button" :class="ui.linkButton()" @click="showOtherMachines">{{ t(`setup.setup.runOnMyOwn`) }}</button>
                            </nav>
                        </template>

                        <!-- The command area appears only when its path is ready. -->
                        <template v-else-if="!commandReady">
                            <template v-if="setupError">
                                <Notice :of="setupError" />
                                <Button :label="t(`ui.action.tryAgain`)" class="w-full justify-center md:w-fit" @click="remint">
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
                            <!-- In-app setup hands the command to the app. -->
                            <template v-if="desktop">
                                <p class="text-xs text-muted">
                                    {{ t(`setup.setup.installsDockerNeedStarts`) }}
                                </p>
                                <Button :label="t(`setup.setup.setUpNow`)" class="w-full justify-center md:w-fit" @click="runHere">
                                    <template #icon><Icon name="bolt" /></template>
                                </Button>
                            </template>

                            <!-- Browser setup exposes one install-earlier action. -->
                            <Button
                                v-if="appFirst && installer"
                                as="a"
                                :href="installer.href"
                                :label="t(`setup.setup.download`, { label: installer.label })"
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
                                :aria-label="t(`setup.setup.otherWaysToSet`)"
                                class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"
                            >
                                <span>{{ t(`setup.setup.otherWaysToSet2`) }}</span>
                                <!-- Show alternate setup links only while their rung is folded. -->
                                <template v-if="otherMachinesFolded">
                                    <button type="button" :class="ui.linkButton()" @click="showOtherMachines">
                                        {{ t(`setup.setup.useMachineWeHost`) }}
                                    </button>
                                    <span aria-hidden="true" class="text-subtle">·</span>
                                </template>
                                <button type="button" :class="ui.linkButton()" @click="showCommand = !showCommand">
                                    <template v-if="showCommand">{{ t(`setup.setup.hideCommand`) }}</template>
                                    <template v-else-if="desktop">{{ t(`setup.setup.showCommandServer`) }}</template>
                                    <template v-else>{{ t(`setup.setup.showCommand`) }}</template>
                                </button>
                            </nav>

                            <div v-if="commandVisible" class="flex flex-col gap-2">
                                <!-- The machine line fills the desktop reference slot. -->
                                <p v-if="!mobile" class="flex items-center gap-2.5 text-xs text-muted">
                                    <Icon name="terminal" class="shrink-0 text-link" />
                                    <span class="min-w-0">
                                        <template v-if="desktop">{{ t(`setup.setup.copyPasteIntoTerminal`) }}</template>
                                        <template v-else>{{ t(`setup.setup.pasteIntoTerminalComputer`) }}</template>
                                    </span>
                                </p>
                                <!-- Copy stays beside the command on desktop and below it on phones. -->
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
                                        :label="t(`ui.action.copy`)"
                                        class="text-xs"
                                        @copied="onCopied"
                                    />
                                </div>
                                <SetupCompose v-if="runTab === `compose` && composeArgs" :args="composeArgs" />
                                <template v-else>
                                    <!-- Clamp the command on phones so the next step stays visible. -->
                                    <Code
                                        :code="selectedCommand"
                                        :lang="selectedCommandLang"
                                        :wrap="true"
                                        :copyable="false"
                                        :clamp-lines="mobile ? 4 : undefined"
                                    />
                                    <!-- The copy action is full-width and touch-sized on phones. -->
                                    <CopyButton
                                        v-if="mobile"
                                        :text="selectedCommand"
                                        :label="t(`setup.setup.copyCommand`)"
                                        :stretch="true"
                                        severity="secondary"
                                        @copied="onCopied"
                                    />
                                    <!-- Local development guidance stays folded behind the same gate. -->
                                    <details v-if="buildsFromCheckout" class="text-xs text-warning">
                                        <summary class="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                                            <Icon name="box" class="shrink-0" />
                                            <span class="min-w-0">{{ t(`setup.setup.localDevBuildsCheckout`) }}</span>
                                            <Icon name="chevron-down" class="shrink-0 text-subtle" />
                                        </summary>
                                        <p class="mt-1 pl-6">
                                            {{ t(`setup.setup.commandBuilds`) }} <code>{{ DEV_SANDBOX_IMAGE }}</code>
                                            {{ t(`setup.setup.checkoutRunsEveryRun`) }} <code>pnpm dev:sandbox</code> {{ t(`setup.setup.running`) }}
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
                                    <span class="shrink-0 text-content">{{ t(`setup.setup.iAlreadyDocker`) }}</span>
                                </label>
                                <span class="min-w-0">
                                    <template v-if="hasDocker">{{ t(`setup.setup.runsNo`) }} <code>sudo</code>.</template>
                                    <template v-else><code>sudo</code> {{ t(`setup.setup.oneJobInstallingDocker`) }}</template>
                                </span>
                            </div>

                            <!-- Sync for widths with no reference column; survives folding in the app, but not on the compose tab. -->
                            <SetupSyncOption v-if="syncOffered" v-model="syncEnabled" :folder="syncDir" class="xl:hidden" />
                        </template>

                        <!-- Keep the spinner visible while polling and use color to show ownership. -->
                        <div v-if="commandReady" class="flex flex-col gap-2">
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
                                    <!-- The machine's reported stage overrides the fallback label. -->
                                    <template v-if="handoff === `claimed` && buildStage !== undefined">
                                        <span class="font-medium text-success">{{ t(`setup.setup.machinePickedUp`) }}</span>
                                        {{ t(`setup.setup.rightNow`) }} {{ buildStage }}.
                                    </template>
                                    <template v-else-if="handoff === `claimed`">
                                        <span class="font-medium text-success">{{ t(`setup.setup.machinePickedUp`) }}</span>
                                        {{ t(`setup.setup.startingDockerFirstRun`) }}
                                    </template>
                                    <!-- Copied commands require a paste; the app path opens its own window. -->
                                    <template v-else-if="handoff === `handed` && launched && desktopReport">
                                        <span class="font-medium text-content">{{ t(`setup.setup.appSettingUp`) }}</span>
                                        {{ t(`setup.setup.pageOpensWorkspaceMoment`) }}
                                    </template>
                                    <template v-else-if="handoff === `handed` && launched">
                                        <span class="font-medium text-content">{{ t(`setup.setup.handedToApp`) }}</span>
                                        {{ t(`setup.setup.followInIntenticWindow`) }}
                                    </template>
                                    <template v-else-if="handoff === `handed`">
                                        <span class="font-medium text-content">{{ t(`setup.setup.copied`) }}</span>
                                        {{ t(`setup.setup.pasteIntoTerminalPress`) }}
                                    </template>
                                    <!-- This names the actor responsible for the next setup step. -->
                                    <template v-else-if="desktop && !commandVisible">
                                        <span class="font-medium text-content">{{ t(`setup.setup.waitingToStart`) }}</span>
                                        {{ t(`setup.setup.nothingRunsUntilPress`) }}
                                    </template>
                                    <!-- Browser and app setup use the same action sentence. -->
                                    <template v-else-if="installing">
                                        <span class="font-medium text-content">{{ t(`setup.setup.waitingToStart`) }}</span>
                                        {{ t(`setup.setup.nothingRunsUntilInstall`) }}
                                    </template>
                                    <template v-else>
                                        <span class="font-medium text-content">{{ t(`setup.setup.waitingToRunCommand`) }}</span>
                                        {{ t(`setup.setup.wellNoticeMomentSandbox`) }}
                                    </template>
                                </span>
                            </p>

                            <!-- THE APP'S OWN BAR, on this page: what "Back to your workspace" leaves behind. -->
                            <DesktopSetupProgress
                                v-if="launched && desktopReport && handoff !== `claimed`"
                                :report="desktopReport"
                                :heard-at="desktopHeardAt"
                            />

                            <!-- The machine said exactly what broke: render it verbatim, problem and fix per check, and the one instruction that is always true. -->
                            <Notice v-if="reportFailures !== null" :of="{ tone: `danger`, title: t(`setup.setup.failedOnYourMachine`) }">
                                <ul class="mt-1.5 flex flex-col gap-1.5">
                                    <li v-for="failure in reportFailures" :key="failure.check" class="min-w-0 text-2xs">
                                        <span class="font-medium">{{ failure.check }}:</span> {{ failure.problem }}
                                        <span v-if="failure.remedy !== ``">{{ t(`setup.setup.fix`, { remedy: failure.remedy }) }}</span>
                                    </li>
                                </ul>
                                <p class="mt-1.5 text-2xs">
                                    {{
                                        retriedByButton
                                            ? t(`setup.setup.fixAbovePressAgain`, { button: t(`setup.setup.setUpNow`) })
                                            : t(`setup.setup.fixAboveRunSame`)
                                    }}
                                </p>
                            </Notice>

                            <!-- Wide screens move this explanation into the reference column. -->
                            <SetupNudge
                                v-if="nudging"
                                class="xl:hidden"
                                :variant="nudgeVariant"
                                :stalled="stalled"
                                :command="selectedCommand"
                                :copyable="nudgeCopyable"
                                @copied="onCopied"
                            />

                            <!-- Claimed-but-silent differs from never-run: the command ran, so the terminal has the answer. -->
                            <p v-if="slowBuild" class="flex items-start gap-2 text-xs text-warning">
                                <Icon name="exclamation-circle" class="mt-0.5 shrink-0" />
                                <!-- Check launch state, not visibility, before handing a command to the app. -->
                                <span class="min-w-0">{{
                                    t(`setup.setup.pickedUpNoSandbox`, {
                                        where: launched ? t(`setup.setup.theIntenticWindow`) : t(`setup.setup.thatTerminal`),
                                    })
                                }}</span>
                            </p>
                        </div>
                        <p v-if="status" class="text-xs text-warning">{{ status }}</p>
                    </section>
                </div>

                <!-- Docked reference for the run step only; `xl:w-88` is measured to fit the longest cleanup one-liner on one line, not a guess. -->
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

        <!-- The one action on this page that destroys data, and the page it lands on looks like a fresh setup either
             way; the question is the only thing between the two. -->
        <ConfirmDialog
            :open="handBackAsked"
            :header="t(`setup.setup.handBackHeader`)"
            header-icon="exclamation-triangle"
            :confirm-label="t(`setup.setup.handBackConfirm`)"
            :loading="releasingHosted"
            size="md"
            @cancel="handBackAsked = false"
            @confirm="confirmHandBack"
        >
            <div class="flex flex-col gap-3">
                <p class="text-sm text-muted">{{ t(`setup.setup.handBackFiles`, { name: created?.name ?? `` }) }}</p>
                <p class="text-sm text-muted">{{ t(`setup.setup.handBackKeeps`) }}</p>
            </div>
        </ConfirmDialog>
    </div>
</template>

<style scoped>
/* Shared material lives in @intentic/entry-css (metals, ink, faces, plate, type). */

/* The ground: how far the picture reaches, and where the veil closes over it. */
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
.mast-headline {
    /* Sized between the door's headline and a page hero, since this one shares its screen with a decision. */
    font-family: var(--face-display);
    font-size: clamp(1.75rem, 4.6vw, 2.75rem);
    font-weight: var(--font-weight-semibold);
    line-height: 1.24;
    text-wrap: balance;
}
.mast-lede {
    margin-top: 1rem;
    /* 56ch, not a rem cap, matches the site's character-counted columns (45-75); both lanes fit two lines. */
    max-width: 56ch;
    font-size: 1.0625rem;
    line-height: 1.6;
    color: var(--ink-lede);
    text-wrap: pretty;
}

/* Framed cards: `.entry-frame` draws the double rule and plate; padding lives here since it's the responsive part and must clear the ornament. */
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
    font-weight: var(--font-weight-semibold);
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
/* The plate with a little of the page's own metal worked into it, so the step is the same size in both dresses. */
.rung:hover:not(:disabled) {
    border-color: var(--rule-strong);
    background: color-mix(in oklab, var(--gold) 5%, var(--plate));
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
    background: color-mix(in oklab, var(--gold) 8%, var(--plate));
    /* A hairline outside the first adds weight without resizing; the shadow lifts it off the others' shelf. */
    box-shadow:
        0 0 0 1px color-mix(in srgb, var(--gold) 22%, transparent),
        var(--ui-shadow-2);
    transform: translateY(-1px);
}
.rung-name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.35rem;
    font-family: var(--face-mark);
    font-size: 1rem;
    font-weight: var(--font-weight-semibold);
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
    filter: var(--house-ember-mark-glow);
}
.rung-cost {
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--gold);
}
</style>
