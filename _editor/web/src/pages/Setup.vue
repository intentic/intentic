<script setup lang="ts">
import type { AddressOffer, HostedOffer, SandboxSummary, SetupCode, SetupReport, HostedStatus } from "@intentic-app/api-contract";
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
import { revealConversation } from "../composables/agents/agentActions";
import { track } from "../composables/analytics";
import { composingConversation } from "../composables/chat/useChat";
import { apiClient } from "../composables/useApi";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import CloudflareTokenField from "../components/CloudflareTokenField.vue";
import { useCloudflareZones } from "../composables/extensions/useCloudflareZones";
import { sandboxIdFromToken } from "../composables/sandbox/sandboxIdFromToken";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { desktopInstaller, desktopSetupLink, desktopVersion, openDesktopLink } from "../environments/desktop";
import { environment } from "../environments/environment";
import { bashCommand, psCommand, scriptSource } from "../environments/scriptCommand";
import SetupCloud from "./SetupCloud.vue";
import SetupCompose from "./SetupCompose.vue";
import SetupHandoff from "./SetupHandoff.vue";
import SetupNudge from "./SetupNudge.vue";
import SetupRunDetails from "./SetupRunDetails.vue";
import SetupRungArt from "./SetupRungArt.vue";
import SetupSyncOption from "./SetupSyncOption.vue";
import { cloudProviderMeta } from "./setupCloud";
import type { ComposeArgs } from "./setupCompose";
import { type AttachOutcome, daemonUrlProblem, normalizeDaemonUrl, probeDaemon } from "./setupAttach";
import { autoSandboxName } from "./setupName";
import { setupReportView } from "./setupReport";
import { hostedWaitView } from "./hostedWait";
import AppBrand from "../components/AppBrand.vue";

/* The setup gate's destination (outside the workspace shell). Setup asks for no identity decisions: the
 * sandbox is created on arrival under a name this page picks (autoCreate + setupName.ts), and that name stays
 * out of onboarding. It can be changed later in the workspace, where it is useful for telling machines apart.
 *
 * THE ADDRESS IS REPORTED BY STEP 2 rather than by step 1, because it is a consequence of the rung rather than
 * a fact about the sandbox, and because a hex hostname in the page's first position is three lines a stranger
 * has to skip to reach the only choice on the page. It leads the run card, above the command that carries it.
 * It is also where the two reachability paths part:
 *   • intentic-provided (default): the platform provisions a Cloudflare tunnel under its OWN zone; the user needs no
 *     Cloudflare of their own. The subdomain is fixed (server-derived from the connection token), so this path IS
 *     the one-liner and the escape hatch shares its row.
 *   • own Cloudflare: the user pastes their token, picks a zone, and edits the subdomain; the sandbox creates its own
 *     tunnel. The token only reaches the platform for a request-scoped zone listing, then is dropped: on this path it
 *     rides the command as a CF_TOKEN env var, never stored. That is a form, and it expands the step in place.
 * Either way the platform mints a SHORT-LIVED SETUP CODE (sandbox.setupCode) for the chosen target; the copy-paste
 * command carries only that code and the connect script redeems it at POST /setup/claim for the real values, so no
 * raw token lands in shell history. Step 2 also offers desktop sync (on by default): the choice + folder ride the
 * same code (SYNC_DIR + a platform-minted single-use SYNC_PAIR_TOKEN in the payload), so the one pasted command
 * additionally enrolls the sync agent after the sandbox boots: no second paste. Step 2 also carries the CLOUD
 * MACHINE choice (`machine` below, SetupCloud.vue): no computer to paste into, so one is created in the user's
 * own cloud account and its first boot claims this same code headlessly. Once running, the DAEMON announces
 * its URL + liveness to the platform; this page just polls sandbox.list for a fresh lastSeenAt and then opens the
 * workspace: the browser never resolves the sandbox hostname here, so no DNS race can wedge setup. That wait is
 * step 2's own footer rather than a step of its own: it asks the user for nothing, so a card of its own was chrome
 * around one sentence, and the sentence belongs under the command whose result it is reporting.
 *
 * Step 2 is also where the flow is most often abandoned, not because a pasted command does more than an .msi
 * would, but because it shows up without any of an installer's affordances. So where we ship a build for the
 * machine reading the page, step 2 IS the .msi (`appFirst`) and the command folds behind one link; where we
 * don't, the card states what will be created, what it writes outside Docker and how to remove all of it, and
 * offers the one switch that reshapes the command instead of leaving the reader to abandon it: `hasDocker`
 * (drop the `sudo`, which is only ever there to install Docker).
 *
 * That is the PROVISION lane. There is a second, one-step ATTACH lane for a user whose sandbox is already running
 * behind a domain of their own: they paste the address, the browser probes it (setupAttach.ts), and sandbox.attach
 * records it: no tunnel to provision, no command to run, no announce to wait for, so step 2 never renders.
 * `lane` decides which spine step 1 is the head of.
 *
 * The two lanes SHARE the same `created` row rather than mirroring it. That is what makes a lane switch lossless
 * in either direction: a row created by an attach whose probe passed but whose attach then failed continues as
 * the provision lane's sandbox instead of being stranded. `targetKey` is gated on the lane for the same reason
 * in reverse: minting is what buys the Cloudflare tunnel, and an attached sandbox is reached over the user's own
 * domain, so it must not mint. */

const sandbox = useSandbox();
const router = useRouter();
const route = useRoute();
// A phone gets a DIFFERENT step 2, not a narrower one: the command runs on a machine this browser is not, so
// the handoff is the step and the command folds behind a disclosure (see `commandVisible`). The rest of what
// this drives is content the md: classes below cannot reach: the run tabs' labels, and the size and emphasis
// of the controls that carry them.
const { mobile } = useDevice();
const { user } = useAuth();
const { getIdToken, warmIdToken } = useGoogleIdentity();

// The sandbox this page is setting up (holds its connection token). Null only while the auto-create below is in
// flight, or after it failed.
const created = ref<SandboxSummary | null>(null);
// True when we arrived via ?sandbox=<id> and resumed an existing sandbox (vs. created one here now).
const resuming = ref(false);
/* THE ROW ON SCREEN WAS MINTED BY THIS VISIT: the half of the discard rule that says what may be thrown away.
 * A resumed sandbox predates the visit and is somebody's unfinished errand; only a row this page created out of
 * nothing is a draft nobody has agreed to yet. */
const createdHere = ref(false);
// Setup ran to the end: the daemon reported in, or an attach bound one. Set on the way out, because both exits
// navigate and the row's own `lastSeenAt` in `created` can still be the pre-announce copy at that moment.
const finished = ref(false);
const creating = ref(false);
const error = ref<NoticeModel | null>(null);
/* Has the arrival read answered yet. `created === null && !creating` is the shape of a FAILED create, and it is
 * also the shape of the first frame of every visit, so without this the card opens on its own error state and
 * corrects itself a round-trip later. Set once, in a finally, so a mount read that throws still lands on a card
 * that offers the retry rather than spinning forever. */
const loaded = ref(false);

// Is there a workspace to go BACK to: some sandbox other than the one being set up here that has actually
// reported in. Both halves matter: a row this page created moments ago is not somewhere to return to, and
// neither is one that has never had a daemon (its shell would open on a connecting gate that never resolves).
const otherWorkspace = computed(() => sandbox.sandboxes.value.some((entry) => entry.id !== created.value?.id && entry.lastSeenAt !== null));

// The reachability mode (step 1's address line). Default is the zero-config intentic-provided path; "own" is the bring-your-own-Cloudflare toggle.
const mode = ref<"intentic" | "own">(`intentic`);
/* Whether this platform hands out addresses at all: `undefined` until sandbox.addressOffer answers on
 * arrival, and the gate on every lane that needs one (see `addressed` below).
 *
 * IT STARTS UNKNOWN RATHER THAN TRUE, and that is the whole of the fix it exists for. Assuming the offer was
 * there meant a platform without it drew the machine ladder in full, minted against a route that answers
 * "not here", and then took the cloud rung back off screen: two options that appeared for one round-trip and
 * vanished, over an address line left spinning on "Preparing your intentic domain…" forever, because nothing
 * told it the answer would never come. Unknown draws neither, so nothing has to be retracted. */
const intenticAvailable = ref<boolean | undefined>(undefined);
// This platform mints addresses: the answer is in, and it is yes. The lanes that need one gate on this.
const addressed = computed(() => intenticAvailable.value === true);
// …and it is no. Distinct from "not yet": the first is a fact to state on the card, the second is a wait.
const addressless = computed(() => intenticAvailable.value === false);

// --- setup code state (both paths) ---
// The minted {code, hostname, expiresAt} for the currently chosen target; the command carries only the code.
const setup = ref<SetupCode | null>(null);
const setupError = ref<NoticeModel | undefined>(undefined);
// The target key `setup` was minted for, so watcher re-fires don't re-mint and a stale mint is discarded.
const mintedFor = ref<string | undefined>(undefined);
let mintTimer: ReturnType<typeof setTimeout> | undefined;

// --- own-Cloudflare path state ---
// Token + zone discovery is shared with the in-app Connect Cloudflare step (useCloudflareZones). Here it only
// feeds the setup-code target: on this path the token rides the install command, it isn't written to .env.
const cf = useCloudflareZones();
const { cfToken, cfTokenValid, selectedZone, zonesLoading, zonesError } = cf;
// Zones are domains: monospace rows behind a filterable picker, since an account-wide token can carry dozens.
// The editable subdomain prefix, pre-filled with the derived `sandbox-<hash>` default (so an untouched field
// reproduces the CLI's default). The full hostname is `<subdomain>.<selectedZone>`.
const subdomain = ref(``);
const derivedPrefix = ref(``);
const subdomainValid = computed(() => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(subdomain.value.trim()));

// --- desktop sync opt-in (step 2) ---
// On by default: the same pasted command also enrolls the sync agent. The folder rides the command as a
// SYNC_DIR env var (a path, not a secret), so toggling this just adds/removes it: no re-mint. The folder is
// derived from the sandbox name AND the hostname the mint just provisioned (not user-editable): shown as
// info, not a field, so it carries the same id the sandbox's address does. Empty until the mint lands, which
// is also when the command that would carry it appears.
const syncEnabled = ref(true);
const syncDir = computed(() => (created.value && setup.value ? syncFolder(created.value.name, setup.value.hostname) : ``));

// --- attach lane (step 1's one-step alternative) ---
// Which spine step 1 heads: `provision` (address, then run and wait) or `attach` (paste the domain
// the sandbox is ALREADY reachable at → verify → workspace), which finishes inside step 1 itself.
//
// Both lanes work on the SAME `created` row: a sandbox's identity is a fact about the sandbox, not about how the
// user chose to reach it. Duplicating it into lane-local state is what makes a lane switch strand a row, so
// there is deliberately no `attachRow` here.
const lane = ref<"provision" | "attach">(`provision`);
/* The one "reach it some other way" disclosure, open. Both ways off the default address: your own Cloudflare
 * zone, and a domain the sandbox already answers on: used to be their own link in their own place, and
 * telling them apart needed the distinction they exist to explain. One link, two choices under it, each
 * described by what the reader already knows about their own machine. */
const reaching = ref(false);
const domain = ref(``);
// The connection token the daemon was started with, revealed only after a `needs-token` probe. Used for that
// one first-bind request and never persisted: the daemon stops caring the moment an owner is bound, so the
// platform has no reason to hold a copy (same posture as the Cloudflare token above).
const attachToken = ref(``);
const attaching = ref(false);
const attachOutcome = ref<AttachOutcome | undefined>(undefined);

const normalizedDomain = computed(() => normalizeDaemonUrl(domain.value));
const domainProblem = computed(() => daemonUrlProblem(domain.value));

// A resumed sandbox that has ACTUALLY run before is being reconnected; one that was named and never started is
// just being picked back up, and calling that "Reconnect" claims a history it doesn't have. Read by the
// resumed sandbox's own line, which is the only place on the card that says which of the two this is: the
// provision card carries no title to put it in.
const neverStarted = computed(() => created.value !== null && created.value.lastSeenAt === null);

// Step 2 shows one command at a time; the preferred OS is a persisted singleton shared across screens.
const { cmdOs } = useOsPreference();

// The third Run tab: manage the sandbox with the user's own docker-compose.yml instead of the install
// script. Local state layered over the persisted OS preference: picking Compose must not overwrite the
// unix/windows choice other screens share (CommandOs stays a two-value type).
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
// Two of the three labels shed a qualifier on a phone, where the three tabs share one line: the shell
// ("PowerShell") and the vendor ("Docker") are both restated by the panel each tab opens, and a tab that wraps
// to two lines while its neighbours don't stops reading as one control.
// The third tab is on a different axis from the first two: it is not another OS, it is the path for someone
// who would rather read a file than run a script, and its label can't say so without outgrowing the row. The
// title says it on a desktop and the panel's own first line says it everywhere, which is where the reader who
// needs it actually arrives.
const runTabOptions = computed(() => [
    { label: `Linux / macOS`, value: `unix` as const },
    { label: mobile.value ? `Windows` : `Windows (PowerShell)`, value: `windows` as const },
    {
        label: mobile.value ? `Compose` : `Docker Compose`,
        value: `compose` as const,
        title: `No script runs: read the whole file, then start it yourself`,
    },
]);

/* The one control over the SHAPE of the pasted command. It exists because a copy-paste install is the point
 * people balk at, not because it does more than an .exe would, but because it arrives with none of an
 * installer's affordances: no publisher, no preview, no file list, no uninstaller.
 *
 * `hasDocker` drops the `sudo`. It is in there for exactly one job: installing Docker when the machine has
 * none (connect.sh's require_root_to_install_docker states the same deal from the other side), and for a
 * developer who already runs Docker it is the single most alarming token in the line. Not persisted: it is a
 * claim about the machine the user is about to paste into, which is not necessarily the one they are reading on.
 *
 * It used to have a peer: a `review` switch that split the one-liner into download-it, read it, then run the
 * file. It was removed because it read as a WARNING rather than an offer: a checkbox telling you to read
 * something before running it is an admission that running it is unsafe, on the one step where hesitation is
 * what loses people. The reference panel already says what the command creates and how to undo it, and the
 * desktop app is the real answer for anyone who wants an installer instead of a pipe. */
const hasDocker = ref(false);

/* THE THIRD WAY TO RUN STEP 3: the desktop app (_editor/desktop-app), when this page is being read INSIDE it.
 *
 * It is the same handoff the command is: the app claims this same setup code and runs the same connect
 * script, so nothing about steps 1-2 or the announce-watch below changes. What it removes is the terminal:
 * which is what people actually balk at here, and what the two switches above can only soften.
 *
 * So inside the app step 2 IS that button, not a second offer beside a command: one line of consequence, the
 * button, and a link for the person who wanted a server after all. Everything below that belongs to the
 * COMMAND rather than to the step: the paste-it-into-a-terminal line, the `sudo` switch, "Copy again":
 * is gated on the command actually being on screen, because in the app it usually isn't.
 *
 * A browser that is NOT the app still gets the link (the OS routes it to an installed app) plus somewhere to
 * download one; the pasted command stays the primary path there, because it is the one that always works. */
const desktop = computed(() => desktopVersion() !== undefined);

/* …AND THE APP AS THE FRONT DOOR OF THE OWN-COMPUTER LANE, for a browser on a machine we ship a build for.
 *
 * `curl -fsSL … | sudo sh` is the most alarm-raising string this product puts in front of anybody, and it was
 * the DEFAULT rung's first screen: preselected, above the fold, before a stranger had seen the product. The
 * people who are comfortable with it are exactly the people who would find it behind one click without a
 * flinch, so the default exposed the timid and protected the confident, which is the wrong way round. The
 * installer is the same handoff wearing an installer's affordances (a publisher, a file, an uninstaller),
 * which is the whole of what the two switches under the command were groping for.
 *
 * The command is one labelled click away and loses nothing: it is the direct terminal option the app and phone
 * already carry, and the reader who wants it is guaranteed to recognise the label. Where there is no build
 * (macOS today) this is `undefined` and the command stays the path, because a
 * button pointing at a downloads page that has nothing for you is worse than the pipe it replaced. */
const installer = computed(() => (desktop.value || mobile.value ? undefined : desktopInstaller()));
const appFirst = computed(() => installer.value !== undefined);

/* THE COMMAND IS FOLDED AWAY WHEREVER IT IS NOT THE PATH, behind the same direct option everywhere: in
 * the app the button above already runs it (a server is still an ordinary place to want the sandbox, and the
 * app cannot run it there), on a phone there is no shell to paste into: the handoff is the step there, and
 * the command under it was six controls of scenery around a clipboard write that leads nowhere, and in a
 * browser with an installer to offer, the installer is the step. No reader is shut out: a phone driving a
 * server over SSH is one tap from the same command, and the tap is labelled for exactly that person. */
const showCommand = ref(false);
const commandVisible = computed(() => (desktop.value || mobile.value || appFirst.value ? showCommand.value : true));
// Compose declares its own env, so neither switch under the command applies to it, but "no tab is on screen
// at all" is a different thing from "the compose tab is", and only the second one hides the sync option.
const composeShown = computed(() => commandVisible.value && runTab.value === `compose`);
/* WHICH MACHINE runs step 2: the computer the user already has (the command / handoff / app button), or a
 * new one created in THEIR cloud account (SetupCloud.vue). A phone starts on `cloud` only until the offers
 * land: the hosted rung takes the phone's default the moment it is offered (see arrive()), because a phone
 * can finish it alone off a single tap, where `cloud` opens on a credential paste, the hardest possible
 * opening ask, and the email handoff asks for a second computer. `cloud` stays the phone's fallback on a
 * platform that doesn't host, for the original reason: it is the one classic lane a phone finishes alone.
 * The picker is hidden inside the desktop app (the app IS a computer the user has: its one
 * button is the step there), so `machine` stays `mine` in it by construction.
 *
 * The cloud machine claims the SAME minted setup code the command would, so everything downstream: the
 * locked gate, the claim stamp, the stage report, the announce watch: is untouched; only the card's content
 * and the wait's wording switch on this. It needs the intentic-provided tunnel (the machine boots headless,
 * with no Cloudflare of its own), so the form yields to a pointer at step 1 while `mode` says `own`. */
const machine = ref<"hosted" | "mine" | "cloud">(mobile.value ? `cloud` : `mine`);

/* THE OTHER RUNGS, INSIDE THE APP: hidden by default, never absent.
 *
 * They used to be hard-excluded here on the argument above: the app IS a computer the user has, so a picker
 * offering them a different one is scenery. That holds right up until this computer cannot run it: no WSL2,
 * no Docker, a locked-down work laptop, a machine too small, and then the app has nothing to say and the
 * user has nowhere to go. The app's own requirements screen now links here for exactly that reader
 * (`?elsewhere=1`, desktop-app/src/App.vue), and a link into a page that still hides what it promised would
 * be worse than not offering it.
 *
 * So: local stays the loud default in the app, unchanged and preselected, and the other rungs sit behind one
 * quiet link. `elsewhere` is what opens them: set by the link from the requirements screen, or by that link.
 */
const elsewhere = ref(route.query[`elsewhere`] === `1`);
// Inside the app the other rungs are one click away rather than on screen; outside it, nothing is hidden.
const elsewhereOffered = computed(() => !desktop.value || elsewhere.value);

/* The picker's own row, and the one reason it needs a handle: the link that reveals it sits UNDER the card, and
 * the rungs it reveals appear ABOVE it. Opened silently, all the reader sees is the page growing and the button
 * they were reading sliding down: a click whose entire effect happened off the part of the screen they were
 * looking at. So the reveal takes them to what it revealed. */
const ladderRow = ref<HTMLElement | null>(null);
const showOtherMachines = async (): Promise<void> => {
    elsewhere.value = true;
    await nextTick();
    ladderRow.value?.scrollIntoView({ behavior: `smooth`, block: `center` });
};
const cloudOffered = computed(() => addressed.value && elsewhereOffered.value);
/* The pasted command is an address away from being useless: the script it runs redeems a setup code, and a
 * platform that mints none has nothing for it to redeem. So this rung stands on the same offer the cloud one
 * does: including in the desktop app, where the button IS the command. */
const commandOffered = computed(() => addressed.value);

/* --- the hosted lane (machine === `hosted`) ---
 *
 * The lane with no command, no code and no machine of the user's: the platform gives THIS sandbox a machine
 * it runs (sandbox.hostedProvision), and the ordinary announce watch below carries the rest: the page
 * redirects the moment the daemon reports in, exactly as it does for a pasted run. With the other rungs one click away.
 *
 * A LANE MOVES A MACHINE, NOT THE SANDBOX. Every lane works on the row created on arrival, so choosing this
 * one attaches a machine and choosing another hands it back (sandbox.hostedRelease): the row and its address
 * survive the switch. The first version deleted and re-created the sandbox on every crossing, which is how a
 * mis-click cost a person their place in the flow. */
// The platform's offer, read on arrival. Null until answered; a platform without the route reads as disabled.
const hostedOffer = ref<HostedOffer | null>(null);
const hostedOffered = computed(() => hostedOffer.value?.enabled === true && elsewhereOffered.value);
/* Is there a provision lane to be in at all: a machine we can start, or an address we can put on one the
 * reader starts. With neither, the way BACK to it (the attach lane's last line) is a promise this platform
 * cannot keep, and the attach lane is not a detour off the flow but the whole of it. */
const provisionOffered = computed(() => addressed.value || hostedOffered.value);
// Provisioning/releasing a machine is a round-trip with a provider at the end of it, so the card it was
// clicked on says so rather than freezing.
const hostedBusy = ref(false);
// Why the hosted lane could not be taken, rendered ON the run step where the click happened. Separate from the
// arrival `error` precisely because the first version let a failed hosted attempt bounce the user to the
// command lane with the reason wiped: a silent lane switch that read as the page breaking.
const hostedError = ref<NoticeModel | undefined>(undefined);
// The created row IS a hosted one: the wait card renders off this rather than off the picker, so a resumed
// hosted sandbox narrates correctly however the page was entered.
const hostedRow = computed(() => created.value?.hosted ?? null);
// The allowance is SPENT: this account already has the hosted sandbox it is entitled to, and it isn't this
// one. The card still renders (hiding an option the reader was just offered elsewhere explains nothing); it
// says why it cannot be taken instead.
const hostedSpent = computed(() => hostedOffered.value && (hostedOffer.value?.remaining ?? 0) === 0 && hostedRow.value === null);
/* Is there a lane on the provision spine the reader can actually take: an address for a machine of theirs,
 * a machine of ours still to claim, or one they already have. With none of the three, that spine can only
 * render a step that never unlocks. */
const anyLaneTakeable = computed(() => addressed.value || (hostedOffered.value && !hostedSpent.value) || hostedRow.value !== null);
/* …so the page opens on the lane that still works, and says why once it gets there. Called only once the
 * sandbox row is settled: a RESUMED hosted sandbox is a lane of its own, its machine already exists, and
 * reading the offers alone would have sent it here. Never fires on a platform that mints addresses. */
const fallBackToAttach = (): void => {
    if (!anyLaneTakeable.value) {
        lane.value = `attach`;
    }
};
/* The free lane's awake-hour budget, or null for anyone it does not apply to: a member, or a platform
 * running without a ceiling. The distinction is the whole point of reading it here: `null` means the cards
 * below say nothing about hours at all, rather than showing a member a limit they do not have. */
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
// When the hosted wait began. The command lane's fuses are guesses about a clipboard; this one is only ever
// used to escalate a wait that is otherwise progressing: everything the card actually SAYS comes from what
// the machine and the sandbox report, never from the clock (see hostedWait.ts).
const hostedSince = ref<number | undefined>(undefined);
// The machine's own power state, polled from the platform while, and only while: somebody is waiting on it.
// `undefined` until the first answer, and after any failure to get one: the wait must degrade to its plain
// spinner when the provider can't be asked, never to a wrong story.
const hostedMachine = ref<HostedStatus[`machine`] | undefined>(undefined);
// …once every this many registry polls. The registry is ours and cheap; the machine's state is a provider's
// and rate-limited, and nothing about a boot is missed by asking every dozen seconds instead of every three.
const MACHINE_EVERY = 4;
let machineTick = 0;
/* The sandbox's own last word about its boot, and any check-in we refused: kept as refs the poll writes,
 * beside `claimedAt` and `report` and for the same reason: `created` is the row this page CREATED, and the
 * wait is about what has happened to it since. Both null until they happen, which is also what every sandbox
 * older than this reporting looks like. */
const bootReport = ref<SandboxSummary[`bootReport`]>(null);
const announceRefusal = ref<SandboxSummary[`announceRefusal`]>(null);
// Whether the daemon has ever checked in. Read off the poll rather than off `created` for the same reason.
const announced = ref(false);
// The provisioned machine's display facts (SandboxCloudSchema): set by the provision response (or a resumed
// row that was provisioned last visit), and the switch that turns the cloud form into its summary line.
const cloudMachine = ref<SandboxSummary[`cloud`]>(null);
// The company's NAME, never the picker's pitch: every use below is inside a sentence, and `label` carries
// the free tier's sales line ("Oracle: free 12 GB"), which reads as a typo the moment it lands mid-clause.
const cloudProviderName = computed(() => (cloudMachine.value === null ? `` : cloudProviderMeta(cloudMachine.value.provider).name));
// The provision response is a fresher row (it carries the cloud stamp): adopt it, then let the ordinary
// claim → report → announce watch narrate the machine's first boot.
const onProvisioned = (summary: SandboxSummary): void => {
    created.value = summary;
    cloudMachine.value = summary.cloud;
};

/* THE LADDER: the machine choice as a range of power rather than a binary, each rung captioned by what it
 * costs and what it buys.
 *
 * IT IS A PICKER AND ONE CAPTION, and it has to stay that. The shape this replaced tried to say the same
 * thing with surfaces: a tinted panel for the hosted offer, a bordered list of the other two under it, the
 * chosen one ringed inside that list, and the command's own tab track and code frame under THAT: six framed
 * surfaces deep before a single instruction. Nesting is what a reader pays for structure, and a
 * three-item structure does not need paying for. Weight belongs in the words (the rung order, the caption)
 * and in what is on screen at all, never in another box around it.
 *
 * The rungs are the lanes that already exist; this picker is just the honest map: instant-and-small (hosted)
 * → a free 12 GB cloud machine or a paid one (SetupCloud's providers, Oracle's Always-Free first) → the
 * reader's own hardware (the most power, and the only GPU story anyone can offer). */
/* CARDS, NOT CHIPS. This is the decision the whole rest of onboarding hangs off, whether the reader ever
 * opens a terminal, what the box can do, and who pays for it, and it spent one release as three small pills
 * with a caption underneath, which is the control this design system uses for Preview/Source. A pill row
 * shows only the labels, so the two things that actually decide the answer (what you get, what it asks of
 * you) were invisible until after you had already picked; and the pill for the lane you were on looked
 * exactly like the pill for the lane that would delete it.
 *
 * So: one card per rung, each stating its own trade in the reader's terms, with the cost as a badge, a
 * layout that can be READ before it is clicked. The order is the ladder's: instant and small, then your own
 * hardware, then a machine you rent.
 *
 * READ, THOUGH: NOT STUDIED. The first version of these cards put the whole trade on every card at once:
 * three paragraphs, side by side, above the one command the reader came here to run. Three columns of prose
 * is not a picker; nobody compares three paragraphs, they skim the titles and pick, which means the paragraphs
 * cost attention and bought nothing. A card is an icon, a name, a price and three or four words.
 *
 * What that leaves out lands where it is ACTED on rather than skimmed: the free machine's disk is described on
 * the card that creates it, next to the button, and "or don't use a terminal at all" sits under the whole row
 * as the fourth answer it is. `meta` is the badge, `note` the few words under it. */
/* `value` doubles as the drawing's name (SetupRungArt): a rung and the picture of where its machine lives are
 * the same fact, and an `icon` field beside them was a second place for that fact to be wrong. */
interface MachineOption {
    readonly value: "hosted" | "mine" | "cloud";
    readonly title: string;
    readonly meta: string;
    readonly note: string;
}
const ladderOptions = computed<readonly MachineOption[]>(() => [
    ...(hostedOffered.value
        ? [
              {
                  value: `hosted` as const,
                  /* Titles answer the reader's question (what do I do) never the topology's. This one read
                   * "We host it", which asks a newcomer to weigh hosting arrangements before they have seen
                   * the product. The note is where whose-machine-it-is moved: selling the speed without
                   * saying where it runs would be the quiet push toward our servers this page must not make. */
                  title: `Start instantly`,
                  /* The badge carries the hour ceiling when there is one, because "Free" alone in the place a
                   * reader looks for the cost is the version of this card that has to be corrected later:
                   * AND IT SAYS WHAT HAPPENS AFTER THE HOURS, for the same reason. "40h a month" answers
                   * "how much do I get" and leaves "and then?" hanging, which is precisely the question a
                   * price is read to settle; the honest answer is that a membership lifts the limit (and the
                   * two rungs beside this one never had it): said as the upgrade it is. It read "then
                   * membership" for a release, which names the same fact as a subscription already scheduled.
                   * Members and ceiling-less platforms send no hours at all and read the old way. */
                  meta:
                      hostedHours.value === null ? `Free · ready in seconds` : `Free · ${hostedHours.value.allowance}h a month, more with membership`,
                  note: `Runs on our servers`,
              },
          ]
        : []),
    /* The two rungs where the machine is the READER'S. Neither says more than its three lines, because there
     * is no more to say: "Your CPUs, your RAM, your GPU" is a poem about owning a computer, addressed to
     * somebody who owns one, and "no hour limit, nothing expires" is the badge again in a longer coat. */
    ...(commandOffered.value
        ? [
              {
                  value: `mine` as const,
                  title: `My own computer`,
                  meta: `Most power · no limits`,
                  /* THE NOTE HAS TO NAME THE STEP THE READER WILL ACTUALLY BE GIVEN. This card said "One
                   * pasted command" on every platform, including the two we ship an installer for — where
                   * the step under it is a Download button and no command is ever shown. A picker whose
                   * caption describes a different flow from the one it opens is the picker teaching the
                   * reader to distrust it, on the decision the whole of onboarding hangs off; and it aimed
                   * the terminal-shy reader away from the rung that no longer asks for a terminal. It reads
                   * off the same `installer` the step below does, so the two cannot disagree. */
                  note: installer.value === undefined ? `One pasted command` : `A ${installer.value.label} installer`,
              },
          ]
        : []),
    ...(cloudOffered.value
        ? [
              {
                  value: `cloud` as const,
                  /* WHOSE MACHINE IT IS BELONGS IN THE TITLE, and it is the only thing this rung has to say
                   * that the one above it doesn't: we host one too, and the difference is the account it
                   * lives in and the bill. It used to be "A new cloud machine" over "In your own cloud
                   * account": a title and a note that spent their two lines saying "cloud" twice, so the
                   * card's last line, the one place left to tell the reader something they don't know, was
                   * a paraphrase of its first. It names the three providers instead: somebody who already
                   * has a Hetzner account recognises this rung as theirs from the picker, without opening
                   * it. */
                  title: `My cloud account`,
                  meta: `From free · 12 GB`,
                  note: `Oracle, Hetzner or DigitalOcean`,
              },
          ]
        : []),
]);
/* Shown once there is a CHOICE to make. A picker over one rung is not a picker: it is a card describing the
 * only thing on offer, which is what the step under it already does, and while the offers are still being
 * read there is nothing honest to draw at all. */
const ladderShown = computed(() => elsewhereOffered.value && ladderOptions.value.length > 1);

/* A RUNG CHOSEN BEFORE THIS PAGE, off `?machine=`: the contract the public site's /where-it-runs cards link
 * through. That page is where a stranger can be told what each rung costs and asks of them at the length the
 * decision deserves, which is a length this page has repeatedly and correctly refused to grow to. Somebody
 * who has just read three paragraphs about running it on their own computer and clicked the button under
 * them has MADE the choice; re-asking it here is the page telling them their click meant nothing.
 *
 * Validated against `ladderOptions` rather than against the three literals, so a rung this platform does not
 * offer (no address mint, no hosted allowance) is ignored and the ordinary default stands. A stale link from
 * a cached page then costs nothing: the reader lands on a working picker, never on a step that cannot unlock.
 * Read once, on arrival: it is where the reader came FROM, not a control, so a lane switch here must not be
 * undone by it and it is deliberately not watched. */
const requestedMachine = (): MachineOption[`value`] | undefined => {
    const asked = route.query[`machine`];
    return ladderOptions.value.find((option) => option.value === asked)?.value;
};

/* WHICH ADDRESS THE CARD IS REPORTING, one of four, and they are mutually exclusive: a hosted machine
 * announces its own, a platform that mints none says so, the default is the intentic domain, and the last is
 * the reader's own Cloudflare zone (the only one that is a FORM rather than a fact, which is why it is the one
 * that still gets a block of its own under the row). */
const addressFact = computed<`hosted` | `none` | `intentic` | `own`>(() =>
    machine.value === `hosted` ? `hosted` : addressless.value ? `none` : mode.value === `intentic` ? `intentic` : `own`,
);

// The quiet label on the address row: the hostname is supporting information, never the card's heading.
const factLabel = `shrink-0 text-sm text-muted`;

// A stable value slot keeps every address state—text, spinner, or failure—on the same baseline.
const factSlot = `flex min-h-8 min-w-0 items-center rounded-md border border-transparent px-2 text-sm text-content`;

// There is one lane now: every sandbox's address is derived from its own connect token, so nothing has to be
// chosen before a code can be minted. `targetKey` survives as the mint's dedupe/stale-response key.
// Identity of the target, for mint dedupe + stale-response drops (a mint answers for the key it was fired for).
// The sandbox id is part of the key: a code redeems ONE sandbox's token, so switching sandboxes mid-page
// (resume → "create a new one instead") invalidates the previous mint instead of showing sandbox A's command
// for sandbox B. The sync choice is deliberately NOT part of this: it rides the command, not the code, so
// toggling it never re-mints.
// The LANE is part of the gate, not just the inputs: minting is what provisions the intentic tunnel + DNS, and
// an attached sandbox reaches the browser over the user's own domain, so a code minted while in the attach
// lane would buy Cloudflare infrastructure nothing will ever dial. Undefined here also re-arms the mint when the
// user comes back: the key changes from undefined to a real one, which is exactly what the watcher fires on.
const targetKey = computed<string | undefined>(() => {
    // The hosted lane never mints: its machine was born holding the tunnel, and a code would buy a command
    // nothing will ever run: same reasoning as the attach lane's gate.
    if (created.value === null || lane.value === `attach` || machine.value === `hosted` || hostedRow.value !== null) {
        return undefined;
    }
    // Nor does a platform that has no addresses to mint, in EITHER mode: the mint is fabric-gated server-side,
    // so bring-your-own-Cloudflare fails there exactly like the default does. Asking anyway is what left the
    // address line spinning on a promise the platform had already declined to make.
    if (!addressed.value) {
        return undefined;
    }
    return created.value.id;
});

// The command can be built only once the chosen target has a code minted for it.
const commandReady = computed(() => setup.value !== null && mintedFor.value === targetKey.value);
/* Desktop sync is an option ON THE PASTED COMMAND: it rides it as an env var, and the folder it names is
 * derived from the address the mint just provisioned. So it exists exactly where that command does: not
 * before a code is minted, not on the compose tab (that file declares its own env), and not in the lanes that
 * run no command of the reader's at all: a cloud machine boots with its own copy, a hosted one was born
 * holding everything. It survives the command being FOLDED away in the app, where it rides the handoff too. */
const syncOffered = computed(
    () => commandReady.value && !composeShown.value && (commandVisible.value || desktop.value) && !(machine.value === `cloud` && cloudOffered.value),
);
// `.title` rather than the NoticeModel itself: interpolated whole, it renders as its own JSON.
const lockedReason = computed(() => {
    // The one state that is not a wait: there is no command coming, so the lock says what is true and the card
    // above carries the way on. "Preparing…" here is the sentence that made this page read as hung.
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

/* --- the handoff (step 2) ---
 *
 * Step 2 is a HANDOFF to a machine this browser cannot see, and every way people get stuck here comes from the
 * card not modelling that. It used to have exactly one state: a spinner and "waiting for your sandbox to report
 * in", shown from the moment the code was minted, so a person who had not opened a terminal and a person whose
 * Docker pull was four minutes deep saw the identical screen, forever. It read as "the platform is provisioning
 * something", which is the one thing it never means, and the only button-shaped thing left on the card was
 * "Check now". So people sat and pressed it, which is also why that button is gone: the registry is polled
 * every 3s either way, so it never bought a single second, and offering it made pressing it look like progress.
 *
 * `handoff` is that missing model, in the order it actually happens:
 *   • `locked` : the chosen path isn't ready, so there is no command yet (lockedReason says what's missing)
 *   • `yours`  : the command is on screen and NOTHING is in flight; the next move is the user's, in a terminal
 *   • `handed` : they copied it (or, in the app, pressed the button), so we are waiting on their machine
 *                 rather than on our own infrastructure
 *   • `claimed`, a machine redeemed the setup code at /setup/claim: the command demonstrably ran, and the
 *                 minutes of invisible Docker work that follow are finally a wait this page has earned
 *
 * The `claimed` state is the one that needed a server change (Sandbox.setupCodeClaimedAt): the claim is the only
 * evidence the platform ever gets that the pasted command reached a machine, and without it the card cannot
 * tell "you haven't run it yet" from "it's running and slow", which is exactly the ambiguity people resolve,
 * wrongly, by waiting. */
type Handoff = "locked" | "yours" | "handed" | "claimed";

// This browser put the command on the clipboard. Page-level and persistent, unlike CopyButton's own 1.5s
// flash: it is the hinge the card turns on, not a button animation.
const copied = ref(false);
// The app was handed the setup code: the desktop path's equivalent of copying, and the last thing this page
// can observe before the machine takes over. Without it, pressing the one button on the card left the footer
// still reading "Nothing is running yet" for as long as it takes the app to claim.
const launched = ref(false);
// A link back to this screen is in the user's inbox (the phone's handoff: SetupHandoff.vue). Deliberately NOT
// part of `handoff` below: that state machine tracks the COMMAND's journey to a machine, and posting yourself a
// bookmark does not advance it by a step. What it does change is what the stuck-wait nudge should say, because
// for this user the next move is on a laptop that hasn't been opened yet rather than in a terminal.
const emailed = ref(false);
// Server-side proof the command ran somewhere: when a machine last redeemed THIS code. Minting clears the
// stamp server-side, so a value here always describes the command currently on screen.
const claimedAt = ref<string | null>(null);
/* The machine's own account of the run (SetupReport): the connect flow posts each stage while it works, and
 * on failure every broken check with its fix. This is the answer to the one question the old card could not
 * answer: a machine that claimed the code and then died left the browser guessing by elapsed time, with the
 * real reason scrolling away in a terminal that may already be closed. Cleared server-side on every mint,
 * like the claim stamp, so a value here always narrates the command currently on screen. */
const report = ref<SetupReport | null>(null);
// Diagnosis or narration, decided in setupReport.ts: `failures` is the card's verbatim what-broke list,
// `stage` the healthy run's live footer line.
const reportFailures = computed(() => setupReportView(report.value).failures);
const buildStage = computed(() => setupReportView(report.value).stage);

// There is a command out there and we're watching the registry: drives the card's footer. Gated on
// `commandReady` rather than a bare mint, so a re-mint's stale command never narrates a wait of its own.
const waiting = computed(() => commandReady.value);
const handoff = computed<Handoff>(() => {
    if (!commandReady.value) {
        return `locked`;
    }
    // A setup report is the same proof as the claim stamp: it can only come from a machine that ran the
    // command, and it can arrive FIRST: the preflight reports "Docker is not running" before anything is
    // redeemed. Without this, that card would say "waiting for you to run the command" beside the failure.
    if (claimedAt.value !== null || report.value !== null) {
        return `claimed`;
    }
    // A provisioned cloud machine is the strongest form of "handed": it will run the command on its own first
    // boot, so from here the wait is on the provider's boot rather than on the user.
    return copied.value || launched.value || cloudMachine.value !== null ? `handed` : `yours`;
});

/* The card escalates on its own, because the failure it guards against is silent: someone who has not realised
 * the command has to be run somewhere else will never do anything this page can react to, so nothing but
 * elapsed time can trigger the correction. `armedAt` is when the command became runnable: reset by a re-mint,
 * which hands out a different command. */
const armedAt = ref<number | undefined>(undefined);
/* THE LAST THING THIS PAGE WATCHED THE READER DO, and the point the fuses below count from.
 *
 * `armedAt` is when a command became runnable, which is the right clock for somebody who has been shown one
 * and done nothing. It is the wrong clock the moment they visibly move: pressing "Download for Windows" is an
 * act this page can see, and it is followed by a browser download, an unsigned-binary warning, a five-screen
 * installer and a sign-in — minutes of work, all of it correct, none of it visible from here. Counting from
 * the mint meant the card interrupted that with "Still nothing. Nothing starts until you install the app
 * above and open it." roughly forty seconds after the click that started it: the page contradicting the
 * reader while they did exactly what it asked. */
const actedAt = ref<number | undefined>(undefined);
// The app's one wall clock, armed only while a command is on screen: nothing below reads it before then
// (waitedMs is 0 without an armedAt, and `claimed` implies one), so an unarmed step 2 costs no tick.
const now = useNow(() => armedAt.value !== undefined || hostedSince.value !== undefined);
watch(commandReady, (ready) => {
    armedAt.value = ready ? Date.now() : undefined;
});

/* THE HOSTED WAIT, decided in one place off three sources (hostedWait.ts): the machine as the provider sees
 * it, the sandbox's own verdict on whether its public address answers, and any check-in we refused. This is
 * what replaced a single sentence that was shown to four different problems.
 *
 * Down here with the other fuses because it reads the clock, but it reads it only to escalate a wait that is
 * otherwise progressing. Everything the card SAYS comes from something somebody established. */
const hostedWait = computed(() =>
    hostedWaitView({
        machine: hostedMachine.value,
        boot: bootReport.value,
        refusal: announceRefusal.value,
        announced: announced.value,
        // The machine's origin off the row's hosted stamp: a pool machine boots in seconds, a built-to-order
        // one spends its first boot downloading, which of the two promises the card makes hangs on this.
        warm: hostedRow.value?.warm,
        waitedMs: hostedSince.value === undefined ? 0 : now.value - hostedSince.value,
    }),
);

// When the card stops being polite about the likeliest reason nothing has reached us: the command is still
// sitting on a clipboard. Long enough to walk to another machine; short enough to catch someone who has
// settled in to watch this page. The compose path is a file to paste into an editor and edited there, so the
// same nudge on that tab would fire at somebody doing exactly the right thing.
// A phone gets the same long fuse, for the same reason in a different shape: the step is a walk to another
// machine BY CONSTRUCTION there, and the handoff above says so before the command is even reached, so forty
// seconds would fire at someone who has understood perfectly and is halfway to their desk.
// A cloud machine's fuse is the longest: its first boot legitimately spends minutes on cloud-init + a Docker
// install + the image pull before anything can claim, and a nudge inside that window would accuse a machine
// that is doing exactly what it should.
// Downloading an installer, running it and signing in again is minutes of work this page cannot see any of,
// so the own-computer lane borrows the phone's long fuse while the app is the path. It drops back to forty
// seconds the moment the command is unfolded, because from then on the wait IS about a clipboard again.
const installing = computed(() => appFirst.value && !commandVisible.value);
/* The installer was fetched from this page. Not proof of anything — a browser download is not an install, and
 * this page never learns whether it finished — but it is the difference between a reader who has not started
 * and one who is several minutes into a process with nothing left for this tab to ask of them. It changes what
 * the nudge SAYS as well as when it fires, because "install the app above" names a step they are past. */
const downloaded = ref(false);
const onDownload = (): void => {
    downloaded.value = true;
    actedAt.value = Date.now();
    track(`desktop_installer_downloaded`, { platform: installer.value?.platform ?? `unknown` });
};
const nudgeAfterMs = computed(() =>
    cloudMachine.value !== null ? 6 * 60_000 : composeShown.value || mobile.value || installing.value ? 3 * 60_000 : 40_000,
);
// And when it stops assuming the command was never run, and starts helping the person whose terminal errored.
const STALLED_MS = 3 * 60_000;
// A claimed code with no daemon behind it yet: the first image pull is genuinely slow, so this waits much
// longer before suggesting the terminal has something to say.
const SLOW_BUILD_MS = 6 * 60_000;

const waitedFrom = computed(() =>
    actedAt.value !== undefined && armedAt.value !== undefined ? Math.max(actedAt.value, armedAt.value) : armedAt.value,
);
const waitedMs = computed(() => (waitedFrom.value === undefined ? 0 : now.value - waitedFrom.value));
// Every fuse below is a GUESS from elapsed time, and a machine report makes guessing obsolete: a failure
// card names the real problem (nudging beside it would say "you haven't run it" about a command that
// demonstrably ran and died), and live stage narration IS the answer slowBuild's "check that terminal" was
// groping for. The fuses stay for machines running an ic too old to report.
const nudging = computed(() => handoff.value !== `claimed` && waitedMs.value > nudgeAfterMs.value);
const stalled = computed(() => handoff.value !== `claimed` && waitedMs.value > STALLED_MS);
/* WHICH READER THE CORRECTION IS ADDRESSED TO (SetupNudge renders the prose). The decision lives here because
 * the state does: a created cloud machine that never claimed sends you to the provider's boot log; a phone
 * that mailed itself the link needs the mail opened on the other computer, not a terminal; and in the app the
 * button IS the path, so "paste this somewhere" would contradict the step above it. */
const nudgeVariant = computed(() => {
    if (cloudMachine.value !== null) {
        return `cloud` as const;
    }
    if (mobile.value && emailed.value) {
        return `emailed` as const;
    }
    if (commandVisible.value) {
        return `terminal` as const;
    }
    // A browser that was offered an installer: nothing has been pasted because nothing was meant to be, and
    // "press the button above" would name a button that is in the app this reader has not installed yet.
    if (installing.value) {
        /* …and once they have taken it, the correction has to move on with them. "Nothing starts until you
         * install the app above" is addressed to somebody who has not pressed the button; saying it to
         * somebody who pressed it three minutes ago reads as the page not having noticed, which is exactly
         * the impression this whole card exists to avoid. The next real step is Windows', not ours. */
        return downloaded.value ? (`downloaded` as const) : (`install` as const);
    }
    if (mobile.value) {
        return `phone` as const;
    }
    return launched.value ? (`app` as const) : (`button` as const);
});
// Copying again is only an answer for the reader who has a command and hasn't run it: never for a phone whose
// clipboard was never the blocked step, and never for a machine that will fetch the command itself.
const nudgeCopyable = computed(
    () => commandVisible.value && runTab.value !== `compose` && !(mobile.value && emailed.value) && cloudMachine.value === null,
);
const slowBuild = computed(
    () =>
        report.value === null &&
        claimedAt.value !== null &&
        handoff.value === `claimed` &&
        now.value - new Date(claimedAt.value).getTime() > SLOW_BUILD_MS,
);

// Copying is the last thing this browser can observe before the user leaves for a terminal, so it is also the
// most informative funnel milestone between "was shown a command" and "ran one".
// `mobile` rides along because the same event means opposite things on the two devices: a copy on a desktop is
// a step towards a terminal that is right there, and a copy on a phone writes to a clipboard no terminal can
// read. Without the split those two average into one meaningless conversion rate, which is why nobody could
// see this screen failing on phones from the funnel alone.
const onCopied = (): void => {
    copied.value = true;
    track(`sandbox_command_copied`, { tab: runTab.value, sync: syncEnabled.value, mobile: mobile.value });
};

// The phone's handoff landed. Its own milestone rather than a flavour of `copied`: it is the first thing this
// screen has ever been able to observe a phone doing that leads somewhere, so the drop-off after it is the
// number worth watching.
const onEmailed = (): void => {
    emailed.value = true;
    track(`sandbox_setup_link_emailed`, { resuming: resuming.value });
};

// LOCAL DEV ONLY: connect.{sh,ps1} redeems the setup code against PLATFORM_URL (host-side; the container never
// reads it), so when the platform is served locally we ride the localhost origin into the command. For the
// hosted platform this is undefined and the command is unchanged (the scripts default to api.intentic.dev).
const platformUrlOverride = computed<string | undefined>(() => {
    const api = new URL(environment.api.url);
    if (api.hostname !== `localhost` && api.hostname !== `127.0.0.1`) {
        return undefined;
    }
    return api.origin;
});

// Hand this setup over to the desktop app: the same code, claimed by the same connect script, run by a
// process that is already on the machine. See environments/desktop.ts for why it is a link and not IPC.
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

// oRPC surfaces a disabled endpoint as NOT_FOUND (404): the signal that the intentic-provided path is off.
const isNotFound = (err: unknown): boolean => {
    if (err && typeof err === `object`) {
        const e = err as { code?: unknown; status?: unknown };
        return e.code === `NOT_FOUND` || e.status === 404;
    }
    return false;
};

// The daemon registers ONCE on boot, so lastSeenAt marks its last (re)start, not a live heartbeat: we can't
// use absolute freshness (a long-running sandbox's stamp is legitimately old). Instead we remember the stamp we
// started watching with and redirect when it ADVANCES: a daemon has (re)booted since the user got the command.
// Comparing two server timestamps to each other is also immune to browser clock skew.
const baseline = ref<string | null>(null);
watch(
    () => created.value?.id,
    () => {
        baseline.value = created.value?.lastSeenAt ?? null;
    },
    { immediate: true },
);

// Why we're still waiting (undefined while nothing informative to say): the run step shows it so a stuck wait names
// its cause instead of spinning silently.
const status = ref<string | undefined>(undefined);
// A poll is in flight. Purely a re-entrancy guard: the 3s interval must not stack requests behind a slow
// one. It is deliberately NOT rendered: it used to drive a "Check now" button's busy state, which meant the
// automatic poll flipped that button's label and icon every third second for as long as the user sat there.
const checking = ref(false);

/* WHERE SETUP LETS GO OF THE USER, both lanes through one function, because where a finished setup lands is one
 * decision and it was made twice.
 *
 * `/` is the shell's own answer per form factor: desktop opens the workspace, where the code is and where the
 * docked chat is already sitting to be typed at. MOBILE HAS NO DOCKED CHAT, so `/` lands it on the agents
 * board, and a board is not a thing you can type into: the first screen of the product was a list with nothing
 * in it. So the hand-off goes one step further there, into the chat the user will actually use, with whatever
 * this sandbox can send with already selected, the free trial on a fresh box.
 *
 * `revealConversation` is the board's OWN push (agentActions), the one its starter chips make, so this opens
 * exactly the screen every other door to a mobile chat opens, and it is a no-op on desktop by construction.
 *
 * After the navigation, never before: selecting the sandbox above re-scopes the chat store (sandboxScope), which
 * rebuilds the conversation list, so a conversation read on this side of that flush is one that still exists. */
const enterWorkspace = async (): Promise<void> => {
    await router.push(`/`);
    revealConversation(composingConversation());
};

/* Poll the platform registry for the daemon's boot registration (POST /sandbox/announce writes daemonUrl +
 * lastSeenAt). When lastSeenAt advances past the baseline, a daemon has come up for this sandbox: open the
 * workspace. Same-origin, no DNS resolution of the sandbox hostname.
 *
 * The row is looked up by `created.id` IN THE LIST THE REFRESH RETURNED, never through `sandbox.active`. Those
 * are the same sandbox only while the selection happens to point at the one being set up, and `reconcileActive`
 * moves the selection to `live[0]` whenever the active id is absent from a list response, which is exactly
 * what a just-created row is until the server read catches up with the write. For an account that already owns
 * a connected sandbox, that fallback put a real `lastSeenAt` in front of a baseline of null, so naming a second
 * sandbox redirected straight into the FIRST one's workspace: setup looked complete, the command was never run,
 * and `sandbox_connected` fired for a daemon that does not exist. Asking about `created` asks the question this
 * screen is actually waiting on. */
const check = async (): Promise<void> => {
    const pending = created.value;
    if (pending === null || checking.value) {
        return;
    }
    // The code this poll is asking about. A response that lands after a re-mint answers for a command that no
    // longer exists, and its claim stamp would report the PREVIOUS command as picked up: the one lie this
    // card must never tell, since the whole point of the stamp is that it is trustworthy.
    const askedFor = mintedFor.value;
    checking.value = true;
    try {
        const live = await sandbox.refresh();
        // A reachable platform clears any earlier "can't reach" warning: it must not outlive its cause.
        status.value = undefined;
        const row = live.find((entry) => entry.id === pending.id);
        if (askedFor === mintedFor.value) {
            const claim = row?.setupCodeClaimedAt ?? null;
            if (claim !== null && claimedAt.value === null) {
                // The funnel's missing middle: they did paste it into a terminal. Everything between here and
                // `sandbox_connected` is Docker's, so a drop-off after this event is a different bug entirely.
                track(`sandbox_command_claimed`, { resuming: resuming.value });
            }
            claimedAt.value = claim;
            const reported = row?.setupReport ?? null;
            if (reported !== null && reported.failed.length > 0 && reportFailures.value === null) {
                // The counterpart of `sandbox_connected` that never existed: setup failed WITH a named cause.
                // Every one of these used to be an invisible drop-off between claim and connect.
                track(`sandbox_setup_failed`, { stage: reported.stage, checks: reported.failed.map((failure) => failure.check).join(`,`) });
            }
            report.value = reported;
        }
        // What the sandbox has said about itself since: the wait card's two other sources.
        bootReport.value = row?.bootReport ?? null;
        announceRefusal.value = row?.announceRefusal ?? null;
        announced.value = (row?.lastSeenAt ?? null) !== null;
        /* The machine's own state, for the wait card's first steps: the only part of the story that exists
         * before the daemon does. Asked for ONLY while a hosted wait is on screen, which is why it is a
         * separate call and not a field on the row every browser polls.
         *
         * And asked for a good deal less often than the registry: at the far end of it is somebody else's API
         * with somebody else's rate limit, and a machine's power state moves on the scale of a boot, not of a
         * poll. A failure leaves the last answer standing: the card falls back to its plain spinner rather
         * than telling a different story every few seconds. */
        if (row !== undefined && (row.hosted ?? null) !== null && machineTick++ % MACHINE_EVERY === 0) {
            hostedMachine.value =
                (await apiClient.sandbox.hostedStatus({ sandboxId: pending.id }).catch(() => undefined))?.machine ?? hostedMachine.value;
        }
        const seen = row?.lastSeenAt ?? null;
        /* THE HANDOVER, and the correction at the heart of this screen. A check-in proves the daemon STARTED;
         * it has never proved anybody can reach it, and taking the first for the second is what walked people
         * into a workspace that could only spin at them. So a sandbox that is telling us its own address does
         * not answer is held here, where there is a reason on screen and a button under it, until it says
         * otherwise.
         *
         * Held, not failed: the box keeps probing and this keeps polling, so the ordinary case (a tunnel that
         * binds a few seconds after the daemon comes up) resolves itself with the reader none the wiser.
         *
         * A sandbox that says NOTHING passes straight through, exactly as before. Silence is what every
         * sandbox older than this reporting looks like, and holding the door against it would wedge the very
         * flows this is meant to unwedge.
         *
         * And ONLY on the hosted lane, because only the hosted lane has a card that can explain the hold. A
         * silent wait with no reason attached is precisely the thing being fixed here; moving one from the
         * workspace onto a step that cannot narrate it would not be a fix, it would be a relocation. The other
         * lanes hand over on the check-in exactly as they always have. */
        const holding = hostedRow.value !== null && hostedWait.value.reachable === false;
        if (seen !== null && seen !== baseline.value && !holding) {
            // Onboarding's make-or-break milestone: the pasted command produced a live daemon.
            track(`sandbox_connected`, { resuming: resuming.value });
            finished.value = true;
            // Point the workspace at the sandbox this page just set up. The same `reconcileActive` fallback that
            // used to trigger this redirect can also have moved the selection away while we were waiting, and
            // opening someone's older sandbox at the end of setting up a new one is the same wrong answer
            // arriving one step later.
            sandbox.select(pending.id);
            await enterWorkspace();
        }
    } catch {
        status.value = `Can't reach the platform to check. Retrying…`;
    } finally {
        checking.value = false;
    }
};

/* Create the sandbox (which mints its connection token) and make it active. Entry point of the flow: the mint
 * watcher below takes over the moment `created` holds a sandbox, and it runs WITHOUT BEING ASKED FOR, on
 * arrival, which is the point.
 *
 * Step 1 used to be a form: an empty field, and a Create button that stayed dead until a word was typed. That
 * word buys nothing at this moment: a name only ever tells sandboxes apart in the switcher, and the first one
 * has nothing to be told apart from, while it costs the two things onboarding can least afford: a decision
 * before anything has been seen, and the seconds of tunnel provisioning that cannot start until a row exists.
 * Naming it here starts the address mint immediately, so the first screen a new account sees is the command.
 *
 * setupName.ts picks a stable default; setup deliberately does not expose naming as another decision.
 */
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

/* WHAT THE ACCOUNT HAS LEFT, ASKED AGAIN EVERY TIME WE CHANGE IT. The offer is the server's count of machines
 * this account holds, and it used to be read once on arrival and never again, so a reader who resumed a
 * hosted sandbox (allowance spent, on that very machine) and then picked another rung was left in front of a
 * page that still counted the machine it had just handed back: the rung they had come off sat disabled under
 * "Already using yours", naming a machine that no longer existed, with no way back to it but a reload.
 * A failed re-read keeps the last answer: this must retract nothing that is still true. */
const refreshHostedOffer = async (): Promise<void> => {
    try {
        hostedOffer.value = await apiClient.sandbox.hostedOffer();
    } catch {
        // A platform that cannot be asked keeps the answer it already gave.
    }
};

/* Give THIS sandbox a machine the platform runs, then let the ordinary announce watch take over. The row is
 * already there (created on arrival like every lane's), so a refusal: capacity weather, the allowance
 * already spent, a platform whose provider credential is wrong, costs nothing but the attempt: the reason
 * lands on this step, the lane falls back to where it was, and the sandbox the reader already has is
 * untouched. `false` when the machine did not happen, so callers can decide what to do next. */
const provisionHosted = async (): Promise<boolean> => {
    const row = created.value;
    if (row === null || hostedBusy.value) {
        return false;
    }
    hostedBusy.value = true;
    hostedError.value = undefined;
    try {
        const updated = await sandbox.hostedProvision(row.id);
        created.value = updated;
        hostedSince.value = Date.now();
        // The zero-command milestone `sandbox_connected` will complete: a hosted machine now exists for this account.
        track(`sandbox_hosted_created`, {});
        return true;
    } catch (err) {
        hostedError.value = noticeFrom(err, `Couldn't start a machine for you right now.`);
        return false;
    } finally {
        // Whether it worked or not, the count on the server may have moved: a refusal is often the allowance
        // being spent somewhere else, which is a thing this page should then be saying. Inside the busy window,
        // so the rungs stay unclickable until the page knows what it is offering.
        await refreshHostedOffer();
        hostedBusy.value = false;
    }
};

/* THE WAIT'S ONE RECOVERY, and the reason its failures are worth naming at all: a diagnosis nobody can act on
 * is a nicer spinner. Which recovery is hostedWait.ts's call, because the two are not interchangeable:
 * `remake` throws the machine away and builds another (the only thing that fixes an address baked in wrong),
 * `reboot` boots the one that exists (enough for a daemon that died or a tunnel that never bound, and it
 * keeps the files). The reader sees one button either way; the difference is which of them is safe.
 *
 * The clock restarts with the machine, so the escalations that follow describe THIS attempt rather than
 * counting from an attempt that has already been abandoned. */
const restartHosted = async (): Promise<void> => {
    const row = created.value;
    if (row === null || hostedBusy.value) {
        return;
    }
    const remake = hostedWait.value.failure?.action === `remake`;
    let released = false;
    hostedBusy.value = true;
    hostedError.value = undefined;
    try {
        if (remake) {
            created.value = await sandbox.hostedRelease(row.id);
            released = true;
        } else {
            await apiClient.sandbox.hostedRestart({ sandboxId: row.id });
        }
        // Whatever the machine last said about itself describes the boot we just replaced.
        bootReport.value = null;
        announceRefusal.value = null;
        announced.value = false;
        hostedMachine.value = undefined;
        hostedSince.value = Date.now();
    } catch (err) {
        hostedError.value = noticeFrom(err, `Couldn't start it over. Try again in a moment.`);
    } finally {
        hostedBusy.value = false;
    }
    // Outside the busy window on purpose: provisioning takes the same flag, and a machine handed back with
    // nothing put in its place is the one outcome this button must not leave behind.
    if (released) {
        await provisionHosted();
    }
};

/* The ladder's switch: it moves a MACHINE, never the sandbox. Choosing the hosted rung provisions one for
 * the row already on screen; choosing another rung hands the machine back (it has never been connected to,
 * so there is nothing on it to lose) and the row carries on into that lane with its identity and address intact.
 * A failure in either direction leaves the reader where they were, with a reason on the card: the previous
 * design deleted and recreated the sandbox around every crossing, so one mis-click threw away the row and,
 * when the provision then failed, silently landed them in a different lane with no explanation. */
const chooseMachine = async (next: "hosted" | "mine" | "cloud"): Promise<void> => {
    const prev = machine.value;
    if (creating.value || hostedBusy.value) {
        return;
    }
    if (next === prev) {
        return;
    }
    hostedError.value = undefined;
    const row = created.value;
    const rowHosted = (row?.hosted ?? null) !== null;
    /* CHOOSING THE HOSTED RUNG STARTS NOTHING. It used to create the machine on the click: the rung WAS the
     * button, so reading the row cost you a machine, and clicking back off it destroyed one. A picker whose
     * options have side effects is not a picker; the card below now carries the button, and until it is
     * pressed this click has done nothing but change what the page is describing. */
    if (next === `hosted`) {
        machine.value = next;
        return;
    }
    if (rowHosted && row !== null) {
        hostedBusy.value = true;
        try {
            created.value = await sandbox.hostedRelease(row.id);
            hostedSince.value = undefined;
        } catch (err) {
            hostedError.value = noticeFrom(err, `Couldn't remove the machine we started. Try again in a moment.`);
            return;
        } finally {
            // The machine we just handed back is the machine the allowance was counting: re-read it before the
            // rungs go live again, so the one being stepped off is takeable the moment it is clickable.
            await refreshHostedOffer();
            hostedBusy.value = false;
        }
    }
    machine.value = next;
};

// Connect a sandbox that is ALREADY reachable: probe the pasted address from this browser, and only once the
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
        // The pasted token wins: it is the one the daemon is actually gating first-bind on. Otherwise present
        // the row's token (a resumed sandbox whose daemon was started from this account's own setup code).
        const pasted = attachToken.value.trim();
        const connectToken = pasted !== `` ? pasted : created.value?.token;
        const outcome = await probeDaemon({ daemonUrl: url, idToken, ...(connectToken !== undefined ? { connectToken } : {}) });
        if (outcome.kind !== `ok`) {
            attachOutcome.value = outcome;
            return;
        }
        // There is normally a row already: one is created on arrival, and reusing it is what keeps a retry
        // after a failed attach from leaving a stray sandbox behind. The create here covers the one case where
        // there isn't: a lane switch made while the arrival create was failing.
        if (created.value === null) {
            await autoCreate();
        }
        const row = created.value;
        if (row === null) {
            return;
        }
        await sandbox.attach(row.id, url);
        // Same milestone as the provision lane's announce: the user has a live sandbox in the workspace, and
        // the workspace has to open on THAT one (see check()).
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

// Flip which lane step 1 heads. Nothing is copied across because nothing is duplicated: any row already created
// stays exactly where it was, including when backing out of a half-finished attach.
const setLane = (next: "provision" | "attach"): void => {
    lane.value = next;
    attachOutcome.value = undefined;
    attachToken.value = ``;
    error.value = null;
    // The chooser that offered this lane has been answered; coming back must not find it still hanging open.
    reaching.value = false;
};

// The chooser's other answer: provision under the reader's own Cloudflare zone, which is a form rather than a
// lane, so only the mode moves.
const chooseOwnZone = (): void => {
    mode.value = `own`;
    reaching.value = false;
};

// Mint the setup code for the chosen target (the intentic path provisions the tunnel + DNS server-side before
// returning, so the hostname it shows already exists). A NOT_FOUND on the intentic path means the feature is
// off: hide the option and fall back to own-Cloudflare. Responses for a stale target are dropped.
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
        // A fresh code is a fresh command, so the handoff starts over: the clipboard holds the old one, the app
        // was handed the old one, and the server has just cleared the claim stamp this mirrors (see setupCode
        // in sandbox.routes.ts).
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

// The locally-built sandbox image a dev sandbox runs. Without it, connect.sh pulls the published
// sandbox:stable, whose daemon predates any unreleased routes the dev web app calls: every new daemon
// endpoint would answer 404 until the next release. connect.sh's ensure_image never pulls a registry-less
// tag: it uses the local image, or builds it from the checkout the dev command runs the script from.
const DEV_SANDBOX_IMAGE = `intentic-sandbox:dev`;

/* …AND ONLY WHEN THE COMMAND STILL RUNS FROM THAT CHECKOUT. `intentic-sandbox:dev` carries no registry, so
 * nothing can ever pull it: connect.sh builds it, and it can only build it when invoked BY PATH, which is the
 * one form that has a repo to build from. Asking for the released script (scriptSource, the switch the
 * connect-a-computer and connect-a-server blocks carry) and still naming the dev tag would hand out a command
 * that silently runs whatever stale `:dev` image happens to be lying around, or dies on a tag it cannot
 * fetch. So the tag rides the checkout form and nothing else; the rest of the dev env is a URL and a volume
 * name, and travels either way. */
const buildsFromCheckout = computed(() => platformUrlOverride.value !== undefined && scriptSource.value === `checkout`);

// The shared env suffix each command carries: the local-dev PLATFORM_URL override (plus the shared dev
// agent-auth volume, so sandboxes created against a localhost platform keep their AI logins across resets,
// and the locally-built sandbox image so the daemon matches the working tree), and SYNC_DIR when desktop
// sync is opted in (a folder path, not a secret: the connect script runs the sync agent only when it's set).
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

/* The daemon emits CORS only for the origins WEB_ORIGIN names, and both connect scripts default it to the
 * hosted app (@intentic/constants PLATFORM_WEB_ORIGIN) because that is the one browser origin that calls a
 * daemon in the normal case. THIS PAGE IS THAT BROWSER, so a build served from anywhere else (the localhost
 * dev SPA, a self-hosted deployment) has to say so in the command it hands out, or the sandbox it creates
 * refuses the very first /health the workspace screen asks for and the user sees only "Failed to fetch".
 * Derived rather than configured: the origin the setup page is loaded from is, by construction, the origin the
 * sandbox has to answer. Omitted when it already matches the default, so the hosted one-liner stays as short
 * as it reads in the docs. */
const webOrigin = (): string | undefined => (globalThis.location.origin === PLATFORM_WEB_ORIGIN ? undefined : globalThis.location.origin);
const webOriginEnv = (): string => {
    const origin = webOrigin();
    return origin === undefined ? `` : ` WEB_ORIGIN='${origin}'`;
};
const webOriginEnvPs = (): string => {
    const origin = webOrigin();
    return origin === undefined ? `` : `$env:WEB_ORIGIN='${origin}'; `;
};

// The commands carry only the short-lived setup code (redeemed by the script at /setup/claim): plus, on the
// own-Cloudflare path, the CF token as an env var (never stored by the platform, so it can't ride the code).
// Everything between the pipe and `sh`: the runner, then the env assignments the script reads.
const linuxPrefix = (): string => {
    const envs = `${mode.value === `own` ? ` CF_TOKEN='${cfToken.value.trim()}'` : ``}${platformEnv()}${webOriginEnv()}${syncEnv()}`;
    // Production's curl|sh install needs root ONLY to install Docker when the machine has none, which is why
    // `hasDocker` can drop it (connect.sh then stops with the remedy rather than escalating). Local dev runs
    // connect.sh BY PATH as the developer, who has docker via their group and their Node toolchain (pnpm) on
    // PATH, so `sudo` there only resets PATH to root's secure_path, which kills the in-repo `pnpm build:sandbox`
    // the dev image is built from: the build fails "pnpm: command not found" and connect.sh silently falls back
    // to the PREVIOUS image, so the sandbox never runs the working tree. No sudo in dev ⇒ the paste rebuilds.
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
// The uninstaller, offered beside the installer: it removes every container, volume and network the command
// creates. Knowing the undo exists before you commit is most of what an .exe's Add/Remove entry is worth.
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
        // Compose has NO build step and is deployed to a host that must PULL the image, so it always
        // references the published registry image, never the local `:dev` tag connect.sh rebuilds from the
        // checkout (a local-only tag can't be pulled and won't exist on a deploy target). The rendered file
        // gets pull_policy: always, tracking the moving `:stable` release.
        image: `ghcr.io/intentic/sandbox:stable`,
        googleClientId: environment.auth.googleClientId,
        webOrigin: globalThis.location.origin,
        ...(platformUrlOverride.value ? { platformUrl: platformUrlOverride.value } : {}),
    };
});

/* Which sandbox this page is setting up. Three ways in:
 *   • an id in the URL: the gate's "Open setup", the switcher's unfinished row, requireSetup's redirect
 *   • nothing in the URL, and the account has NO working sandbox but does own an unfinished one
 *   • none of the above: a fresh account, or the switcher's "Add sandbox", and one is created on the spot
 *
 * The second exists because leaving mid-setup is normal: you get as far as the command, mean to paste it on
 * the other machine, and close the tab. Coming back to a blank first step is worse than useless there: it hides
 * the sandbox you already made. So an account whose only sandbox is unfinished resumes it wherever it enters from.
 *
 * Gated on there being no connected sandbox anywhere, which is what keeps the switcher's "Add sandbox" honest
 *: that button exists to make a SECOND sandbox, and it is only reachable from a shell that already has a
 * working first one.
 *
 * Owned only: a member can't mint someone else's setup code, so their id gets them a sandbox of their own
 * instead. The check loop acts on the ACTIVE sandbox, so select it to make the URL self-contained. */
/* HAS ANYTHING EVER HAPPENED TO THIS SANDBOX: the difference between resuming an errand and adopting a draft.
 *
 * A row exists from the moment /setup is opened (autoCreate), and it outlives the visit. So the ordinary way to
 * meet this page a second time — a reload, a tab reopened, `/` bouncing off requireSetup, and above all THE
 * DESKTOP APP, whose webview loads the SPA at `/` and is redirected here on its very first frame — finds a row
 * the account made seconds ago and never acted on. Calling that "picking up where you left off" tells a person
 * who has been signed up for thirty seconds that they have a past here, and offers to throw away the only
 * sandbox they have. It was the first sentence on the app's first screen.
 *
 * Every clause below is an ACT somebody took, the same set the draft rule is written against (`committed`): a
 * machine redeemed the code, a machine reported on its run, a daemon checked in, or hardware was provisioned
 * for it. None of them, and this is the same draft the page would have created for itself — so it says nothing,
 * and the card reads exactly as it does on a first arrival. */
const touched = (row: SandboxSummary): boolean =>
    // `?? null` on every one of them: these fields are optional as well as nullable (an older platform sends
    // some of them not at all), and `undefined !== null` is true, which would have made every row "touched"
    // and quietly restored the exact behaviour this replaces.
    (row.lastSeenAt ?? null) !== null ||
    (row.setupCodeClaimedAt ?? null) !== null ||
    (row.setupReport ?? null) !== null ||
    (row.cloud ?? null) !== null ||
    (row.hosted ?? null) !== null;

const arrive = async (): Promise<void> => {
    const [rows, offer, address] = await Promise.all([
        sandbox.list(),
        // An older platform without the route reads as "doesn't host": the classic lanes carry on unchanged.
        // Resolve-then-call so even a client missing the method entirely lands in the catch, not in mount.
        Promise.resolve()
            .then(() => apiClient.sandbox.hostedOffer())
            .catch((): HostedOffer => ({ enabled: false, remaining: 0 })),
        // WHAT THIS PLATFORM CAN REACH A SANDBOX WITH, asked before anything is drawn: the two offers land
        // together, so the ladder and the address line are right on their first frame instead of correcting
        // themselves a round-trip later. A platform that cannot answer is one that mints nothing.
        Promise.resolve()
            .then(() => apiClient.sandbox.addressOffer())
            .catch((): AddressOffer => ({ enabled: false })),
    ]);
    hostedOffer.value = offer;
    intenticAvailable.value = address.enabled;
    /* The picker's default may not survive the offers, in two ways. On a platform that mints no addresses,
     * `mine` and `cloud` both point at a step that can only sit locked while the machine we host sits
     * unoffered behind a hidden picker. And a PHONE takes the hosted rung whenever it is on offer: `cloud`
     * earned the phone default by being the one lane a phone finishes alone, but it opens on a cloud
     * credential paste: the hosted rung finishes alone too, off a single tap. */
    if (hostedOffered.value && !hostedSpent.value && (mobile.value || !commandOffered.value)) {
        machine.value = `hosted`;
    }
    /* …and a rung the reader picked on the site outranks both defaults, including the phone one. The device
     * default is a GUESS at what this reader can finish; an explicit click is not a guess. A phone that
     * arrives on `?machine=mine` is somebody reading on their phone about the desktop they are sitting at,
     * and the handoff (SetupHandoff) is exactly the step that case already has. */
    machine.value = requestedMachine() ?? machine.value;
    const requested = route.query[`sandbox`];
    const named = typeof requested === `string` ? rows.find((entry) => entry.id === requested) : undefined;
    const unfinished = rows.some((entry) => entry.lastSeenAt !== null)
        ? undefined
        : rows.find((entry) => entry.role === `owner` && entry.lastSeenAt === null);
    const found = named ?? unfinished;
    if (found?.role !== `owner`) {
        await autoCreate();
        fallBackToAttach();
        return;
    }
    sandbox.select(found.id);
    created.value = found;
    resuming.value = touched(found);
    // A resumed sandbox that was provisioned last visit continues as the story it is: hosted machines may
    // still be booting (or asleep: the wake reflex handles that), and cloud machines hold a code the command
    // lane must not re-ask for.
    if ((found.hosted ?? null) !== null) {
        machine.value = `hosted`;
        hostedSince.value = Date.now();
    } else if (found.cloud !== null) {
        machine.value = `cloud`;
        cloudMachine.value = found.cloud;
    }
    fallBackToAttach();
};

onMounted(async () => {
    try {
        await arrive();
    } finally {
        // Whatever happened, the page now knows as much as it is ever going to: a read that threw leaves a card
        // offering the retry, which is the truth, rather than a spinner that never stops.
        loaded.value = true;
    }
});

/* --- THE DRAFT RULE ---
 *
 * This page creates its sandbox ON ARRIVAL, before the reader has agreed to anything, because the address mint
 * behind it takes seconds this flow cannot afford to spend after the first click (autoCreate says why). The
 * price of that was paid in the switcher: opening the screen and going straight back left a sandbox in the
 * user's list, wearing a "Setup" chip, that they never asked for and could not tell apart from one they meant to
 * make. Looking at a thing must not create it.
 *
 * So the row is a DRAFT until something happens that only somebody who means it would do, and leaving without
 * one of those discards it. Every clause below is an act, not a guess from elapsed time:
 *   • the command is on a clipboard, in an inbox, or handed to the app: it may already be running somewhere
 *   • a machine exists (ours or the reader's cloud account): there is hardware behind this row now
 *   • a machine redeemed the code, or reported on its run: the sandbox is being built as we speak
 *   • the daemon checked in, or an attach bound one: it is a workspace, not a draft
 *
 * Deliberately NOT in the list: which lane or rung is selected, an expanded disclosure, a pasted Cloudflare
 * token, a typed domain that was never verified. Those are all still looking. */
const committed = computed(
    () =>
        finished.value ||
        copied.value ||
        launched.value ||
        emailed.value ||
        claimedAt.value !== null ||
        report.value !== null ||
        announced.value ||
        cloudMachine.value !== null ||
        hostedRow.value !== null,
);

/* Throw the draft away. Owner-delete drops the platform row AND the intentic-provided tunnel the mint bought,
 * so a peek leaves nothing behind on either side, which is the whole point of doing this rather than just
 * hiding the row.
 *
 * Fire-and-forget by design: every caller is on its way somewhere (an unmount, a lane's replacement create), and
 * `remove` drops the row from the shared cache synchronously before its first await, so the switcher is already
 * clean on the frame the reader lands back in the workspace. A failure is swallowed for the same reason it is
 * not retried: nobody is waiting on it, and a sandbox that outlives this is exactly what the switcher's
 * unfinished section is there to catch. */
const discardDraft = (): void => {
    const row = created.value;
    if (row === null || !createdHere.value || committed.value) {
        return;
    }
    createdHere.value = false;
    created.value = null;
    void sandbox.remove(row.id).catch(() => undefined);
};

// Escape hatch from a resumed setup: forget the resumed sandbox and start a new one in its place. Everything
// derived from the resumed sandbox resets too: its minted code, hostname, and token-derived subdomain must
// not leak into the sandbox created next.
const startFresh = (): void => {
    // Walking away from a row THIS visit minted is the same abandonment as leaving the page: the replacement is
    // created two lines down, and two drafts for one reader is the mess this rule exists to prevent. A resumed
    // sandbox is untouched (it fails `createdHere`): it is the user's, from before, and they are only setting it
    // aside.
    discardDraft();
    resuming.value = false;
    created.value = null;
    error.value = null;
    setup.value = null;
    mintedFor.value = undefined;
    setupError.value = undefined;
    // A resumed hosted sandbox being walked away from keeps existing (it is the user's, with their files):
    // but the fresh one starts on the classic lane: the hosted allowance is likely spent on the row being left.
    hostedSince.value = undefined;
    if (machine.value === `hosted`) {
        machine.value = mobile.value ? `cloud` : `mine`;
    }
    // The handoff belonged to the abandoned sandbox's command: a copy already made, a setup already handed to
    // the app, and a claim already recorded are all facts about a machine the next sandbox has nothing to do with.
    copied.value = false;
    launched.value = false;
    claimedAt.value = null;
    // The provisioned machine belongs to the abandoned sandbox: the next one has no machine yet, and keeping
    // the stamp would freeze its mint (see the watcher below) for a VM that claims someone else's code.
    cloudMachine.value = null;
    subdomain.value = ``;
    derivedPrefix.value = ``;
    // The attach lane's inputs described the sandbox being abandoned: a stale domain would otherwise be sitting
    // in the field, ready to be attached to whichever sandbox is created next.
    domain.value = ``;
    attachToken.value = ``;
    attachOutcome.value = undefined;
    void router.replace({ path: `/setup` }); // drop ?sandbox= so a reload doesn't re-resume
    // There is no blank form to drop to any more: the replacement is created here, exactly as it is on arrival.
    void autoCreate();
};

// Watch the registry while we sit on /setup; the moment the daemon reports in, open the workspace.
const timer = setInterval(() => void check(), 3000);

/* And again the instant this page comes back to the front, rather than up to one tick later.
 *
 * Three seconds is the right cadence for a page someone is watching, and the wrong one for a page nobody is:
 * a hidden tab has its timers throttled to something closer to a minute, and inside the desktop app this page
 * is hidden for the WHOLE install: the app's own window takes the frame while the script runs (windows.rs).
 * So the poll that is supposed to notice a live daemon in three seconds noticed it minutes later, and
 * `sandbox_connected` carried that lateness into the funnel with it. Coming back to the front is precisely
 * when the answer is most likely to have changed, so it is worth a poll of its own. `check` is re-entrant
 * (it guards on `checking`), so this costing nothing when a tick is already in flight is by construction. */
const recheck = (): void => {
    if (document.visibilityState === `visible`) {
        void check();
    }
};
document.addEventListener(`visibilitychange`, recheck);
window.addEventListener(`focus`, recheck);

onUnmounted(() => {
    clearInterval(timer);
    clearTimeout(mintTimer);
    document.removeEventListener(`visibilitychange`, recheck);
    window.removeEventListener(`focus`, recheck);
    /* LEAVING WITHOUT COMMITTING THROWS THE DRAFT AWAY: "Back to workspace", the browser's back button, a deep
     * link, any of them. This is the only exit hook there is: `beforeunload` cannot hold a page open for a
     * round-trip, so a closed tab keeps its draft and the switcher's unfinished section is what picks it up. */
    discardDraft();
});

// Mint the setup code whenever the chosen target is complete, debounced so subdomain/folder keystrokes don't
// each mint a code. Re-minting overwrites the previous code server-side. targetKey already carries the
// sandbox id, so a resume→create-new switch re-fires this on its own.
watch(
    targetKey,
    () => {
        clearTimeout(mintTimer);
        const key = targetKey.value;
        if (key === undefined || created.value === null || mintedFor.value === key) {
            return;
        }
        // A provisioned cloud machine boots holding THE minted code: re-minting would overwrite it
        // server-side and the machine's claim would find a code that no longer exists. Once one exists, the
        // code is frozen with it.
        if (cloudMachine.value !== null) {
            return;
        }
        mintTimer = setTimeout(() => void mint(key), 500);
    },
    { immediate: true },
);

// Ask for the address again after a mint that failed: the retry beside the reason on the run step. The
// watcher above only fires on a CHANGED target, and a failure changes nothing about what was asked for, so
// without this the only way back was reloading the page.
const remint = (): void => {
    const key = targetKey.value;
    if (key === undefined) {
        return;
    }
    setupError.value = undefined;
    void mint(key);
};

// Derive the default `sandbox-<hash>` prefix (must mirror the CLI) once the connection token is known, and
// pre-fill the editable subdomain field if the user hasn't typed one.
watch(
    () => created.value?.token,
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

// Warm the browser→sandbox Google credential as soon as the install command is ready, while the user copies and
// runs it: instead of lazily on the first daemon call after the post-connect redirect. The ID token is a
// Google-signed JWT the daemon verifies; minting it needs no daemon, so having it cached means the workspace is
// reachable the instant the daemon reports in (no connecting-gate stall). Fired once.
//
// SILENT, and it must stay that way. This fires the moment step 2 renders a command: the sandbox does not
// exist yet, the command has not been copied, and the user may well close the tab instead. Warming through
// `getIdToken` put a full-screen sign-in gate over that command whenever Google couldn't renew quietly (One Tap
// cooldown, a browser that blocks FedCM), which reads as being asked to sign in twice to set up a machine that
// isn't running. So the prefetch takes a silent renewal when Google offers one and asks for nothing when it
// doesn't; the attach lane's own getIdToken below, and the first daemon call after connecting, are the moments
// where signing in IS the next step and where the gate belongs.
let credentialWarmed = false;
watch(commandReady, (ready) => {
    if (ready && !credentialWarmed) {
        credentialWarmed = true;
        void warmIdToken();
    }
});
</script>

<template>
    <!-- dvh, not vh: a phone's collapsing browser chrome makes 100vh taller than the screen, which parks the
         last step under the address bar on first paint. -->
    <div class="scrollbar-thin min-h-dvh w-full overflow-auto bg-canvas text-content">
        <!-- The page widens at xl to make room for a second column: see the aside below the steps. Below that
             it is the single centred column it has always been, and max-w-3xl still governs the steps
             themselves, so the command never gets narrower than it is today at any width. 74rem is that
             arithmetic: steps (max-w-3xl) + gap + the aside's own width, so widening the aside to fit the
             cleanup one-liner came out of the page's margins rather than out of the steps. -->
        <div
            class="animate-fade-in mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 md:gap-4 md:px-6 md:py-8 xl:max-w-[74rem]"
        >
            <!-- Wraps rather than shrinks: the three items share one line at desktop widths, and on a phone the
                 escape hatch takes the first line on its own (`order-first w-full`) so the title keeps the full
                 width instead of collapsing to "Set up / your / workspace" beside a button pushed off-screen. -->
            <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <!-- Escape hatch for a returning user: they have a workspace that already works, so /'s
                     requireSetup guard lets them back into it. Hidden for a new user, who'd only bounce back:
                     which is what `length > 0` was for, and what it stopped doing the moment this page created
                     a row of its own: naming a sandbox made "Back to workspace" appear beside the very first
                     step, offering a finished workspace to someone who has not run anything yet. -->
                <Button
                    v-if="otherWorkspace"
                    :as="RouterLink"
                    to="/"
                    label="Back to workspace"
                    severity="secondary"
                    :text="true"
                    class="order-first -ml-3 w-full justify-start md:order-last md:ml-auto md:w-auto md:shrink-0"
                >
                    <template #icon><Icon name="arrow-left" /></template>
                </Button>
                <!-- The site's mark, unboxed. A gradient tile and drop shadow put an app-icon treatment around
                     a drawing that already carries the brand, and Sanctum's material language is deliberately
                     flat wherever words sit. -->
                <AppBrand shape="mark" class="shrink-0 text-2xl md:text-3xl" />
                <!-- `contents` on a phone: the h1 becomes the logo's row-mate and the subtitle a full-width row
                     of its own, so the promise gets the whole width instead of a 200px column. From md up the
                     wrapper is a normal block again and the two stack beside the logo as before. -->
                <div class="contents md:block md:min-w-0 md:flex-1">
                    <!-- Medium, not semibold, and every heading under it follows: at a screen's worth of dark
                         surfaces this page was set almost entirely in bold: page title, three step headings, the
                         panel's, and a hierarchy in which everything is emphasised has none. Size and colour
                         carry it now; weight only marks the step you are being asked to read.
                         FOUR SIZES ON THE WHOLE PAGE, and they are the theme's own: this title, a card heading
                         (StepSection's, at the body size), `text-sm` for the things that are VALUES: the two
                         facts, a rung's name, the panel's heading, anything sitting in or beside a field, since
                         `ui.input` is that size, and `text-xs` for every word that is prose. `text-2xs` is
                         gone from this flow entirely: an 11px caption under 12px body is not a tier anybody
                         reads as one, it is the same sentence looking accidentally smaller, and this page had it
                         in nine places. A 24px title over an 11px line was the widest ramp in the app for the
                         screen with the least on it. -->
                    <h1 class="min-w-0 flex-1 text-lg font-medium md:text-xl">Set up your workspace</h1>
                    <!-- The promise has to match the lane: "a few minutes" and "use intentic's domain" describe
                         work the attach lane doesn't do. -->
                    <p class="w-full text-sm text-muted">
                        <template v-if="lane === `attach`"
                            >Point intentic at the sandbox you're already running. One address, and you're in.</template
                        >
                        <template v-else>Pick where it runs. You'll be working in it in a minute or two.</template>
                    </p>
                </div>
            </header>

            <!-- Two columns from xl: the steps, and a docked reference panel that stops covering them. Below xl
                 this is the same single column as before and the panel folds back into step 2's (i) hint.
                 `items-start` is what lets the panel stick while the steps scroll past it. -->
            <div class="flex flex-col gap-3 md:gap-4 xl:flex-row xl:items-start xl:gap-6">
                <div class="flex min-w-0 flex-1 flex-col gap-3 md:gap-4 xl:max-w-3xl">
                    <!-- THE ATTACH LANE'S WHOLE FLOW: one address for a sandbox that is already running and
                         reachable. It keeps a titled card because it ASKS for something: a card with a form on
                         it and no heading is a form nobody knows the purpose of, and it takes an icon rather
                         than a number, since it is the whole flow and a "1" would promise a step 2 that is never
                         coming. -->
                    <StepSection v-if="lane === `attach`" icon="link" title="Connect your sandbox">
                        <!-- WHY YOU ARE HERE, when the page chose this lane rather than the reader. Arriving on
                             "give us your domain" with no explanation reads as a step missing; one sentence
                             naming what this platform does turns it into the flow it actually is. -->
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
                            <!-- Stacked on a phone: side by side, the field loses half its width to the button and
                         the address the user is checking scrolls out of view as they type it. -->
                            <div class="flex flex-col gap-2 md:flex-row md:items-center">
                                <input
                                    v-model="domain"
                                    autocomplete="off"
                                    autocapitalize="off"
                                    spellcheck="false"
                                    placeholder="sandbox.example.com"
                                    :class="ui.input('w-full text-base md:text-sm')"
                                    @keydown.enter="connectDomain"
                                />
                                <!-- `attaching` is in the disabled expression, not left to the loading prop: the
                             theme defines no disabled tokens, so a busy button would otherwise look and
                             feel live while a probe is in flight. -->
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
                        <!-- The tunnel/proxy is alive but has no sandbox behind it: overwhelmingly the case when a
                     resumed sandbox's container is gone, so name that instead of quoting a 530. -->
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
                                    :class="ui.input('w-full text-base md:text-sm')"
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
                        <!-- With a row already in hand, going back CONTINUES that sandbox through the run step rather
                     than setting a new one up: the label has to say which of the two it is.
                     Gone entirely where there is nothing to go back TO: on a platform that neither hosts nor
                     hands out addresses, both labels promise something it cannot do, and this lane is the flow
                     rather than a detour off one. -->
                        <button
                            v-if="provisionOffered"
                            type="button"
                            :class="ui.linkButton(`text-muted underline hover:text-content`)"
                            @click="setLane(`provision`)"
                        >
                            {{ created === null ? `← Set one up for me instead` : `← Get a domain from intentic instead` }}
                        </button>
                    </StepSection>

                    <!-- Naming belongs inside the workspace, where it helps distinguish real machines. The
                         ordinary path therefore has no identity card at all: only exceptional arrival state
                         occupies this space, unframed, before the actual machine choice. -->
                    <div v-else-if="!loaded || created === null || resuming" class="flex flex-col items-start gap-2 py-1">
                        <p v-if="!loaded" class="flex items-center gap-2 text-xs text-muted">
                            <Icon name="spinner" spin class="text-info" />
                        </p>
                        <template v-else-if="created === null">
                            <p v-if="creating" class="flex items-center gap-2 text-xs text-muted">
                                <Icon name="spinner" spin class="text-info" />
                                Setting one up for you. Nothing to fill in.
                            </p>
                            <template v-else>
                                <Notice v-if="error" :of="error" />
                                <Button label="Try again" class="w-full justify-center md:w-fit" @click="autoCreate">
                                    <template #icon><Icon name="refresh" /></template>
                                </Button>
                            </template>
                            <!-- The one-step lane, kept to a single line: it costs the common path nothing and the
                             user who needs it is looking for exactly these words. -->
                            <button type="button" :class="ui.linkButton()" @click="setLane(`attach`)">
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

                    <!-- Step 2: run the sandbox, and the whole reason this page loses people. A copy-paste command is
                 no more dangerous than an .msi, but it arrives without any of an installer's affordances: no
                 publisher, no preview of what will happen, no list of what it changes, no uninstaller.
                 The wait folded in here too: watching for the daemon asked nothing of the user, so a card of its
                 own was chrome around one sentence, and that sentence belongs under the command that causes it.

                 EVERY VISIBLE ACTOR ON THIS CARD IS THE USER. The title used to read "Run your sandbox", which
                 names no one: people read it as something the platform was doing for them, sat through a
                 spinner that started before they had done anything, and pressed the only button on the card
                 ("Check now") until they gave up. So the title gives the instruction and names the machine, and
                 the wait at the bottom is a state machine over the handoff (see `handoff`) rather than one
                 perpetual "waiting…".

                 WHAT IS ON THE CARD IS WHAT YOU DO; WHAT IS IN THE PANEL IS WHAT IT MEANS. The card carries the
                 command, the two switches that reshape it, and one line of state, and nothing else, because a
                 step people are trying to get through is not where prose belongs. Everything that is worth
                 knowing but not worth reading right now (what gets created, what is written outside Docker, how
                 to remove all of it) moved to SetupRunDetails, which is docked in a column of its own from xl
                 and folded into the (i) below it. That is also what fixed the hint landing ON the command it
                 described, on exactly the screens with room to put it beside instead.

                 AND ON A PHONE, WHAT YOU DO IS NOT THE COMMAND. The card here is one sentence, one button and
                 one line of state: the step happens on a computer this browser is not, so the email handoff is
                 the whole of it. The command and everything that dresses it: three tabs, a code block, a copy
                 button, two checkboxes, a dev note: sat between that button and the state line, five bordered
                 surfaces deep (card → panel → button, plus the tab track and the code frame), all of it in
                 service of a clipboard the target machine cannot read. It is now one line's worth of
                 disclosure, addressed to the one reader it is true for: someone holding an SSH session. -->

                    <!-- WHERE THE SANDBOX RUNS, AND THEN THE ONE THING THAT MAKES IT RUN. No step chrome and no
                         heading: the heading could only name ONE of the three answers below it ("Run this on
                         your computer" over a chooser that also offers a machine you never touch), and the
                         chooser says what this card is about better than a title could. -->
                    <!-- THE LADDER: ITS OWN ROW, OUTSIDE EVERY CARD. It answers "which machine", and what
                         follows is the consequence of that answer: nesting it inside the run card put a
                         three-column picker inside a bordered surface inside a column, and the choice read as
                         a detail of the step it actually decides. Out here it is the row the page turns on,
                         and each rung is its own card, which is also what stopped the rungs from needing a
                         card around them to look like objects.
                         Hidden in the desktop app, where "this computer" is the whole point of being in it. -->
                    <div v-if="created && lane === `provision` && ladderShown" ref="ladderRow" class="flex flex-col gap-2">
                        <!-- One column per rung, so two rungs are two halves rather than two thirds of a row
                             with a hole where the third would be. -->
                        <div
                            class="grid gap-2"
                            :class="ladderOptions.length === 2 ? `sm:grid-cols-2` : `sm:grid-cols-3`"
                            role="radiogroup"
                            aria-label="Where the sandbox runs"
                        >
                            <button
                                v-for="option in ladderOptions"
                                :key="option.value"
                                type="button"
                                role="radio"
                                :aria-checked="machine === option.value"
                                :disabled="hostedBusy || (option.value === `hosted` && hostedSpent)"
                                class="flex cursor-pointer flex-col items-start gap-1 rounded-xl border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                                :class="
                                    machine === option.value
                                        ? `border-link bg-overlay`
                                        : `border-line bg-card hover:border-line-strong hover:bg-overlay/40`
                                "
                                v-action="() => chooseMachine(option.value)"
                            >
                                <!-- A PICTURE, NOT A GLYPH (SetupRungArt carries the reasoning). This row used
                                     to be a 16px icon beside the title, after a stacked 2xl glyph was pulled
                                     for spending a third of the card on a bolt that only said "instantly"
                                     again. What sits here now is a drawing of where the machine would live,
                                     which is the one thing on this page a stranger cannot look up, so it
                                     earns the height the synonym could not.
                                     The spinner takes the drawing's PLACE rather than a corner of it: while a
                                     machine is being started there is nothing to choose, and a spinner pinned
                                     to a picture reads as an illustration that has broken. The two stack in one
                                     grid cell and the drawing goes `invisible` rather than away, so the cell
                                     keeps the artwork's exact height and the row cannot jump. A hand-written
                                     height here would be a second copy of a number the drawing already owns. -->
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
                                <span class="min-w-0 text-sm font-medium text-content">{{ option.title }}</span>
                                <span class="text-xs text-muted">{{ option.meta }}</span>
                                <!-- Three or four words: what this rung asks of you, or where it puts the
                                     machine. The sentences that used to sit here are under the row now, for
                                     the rung that was actually chosen. -->
                                <span class="text-xs leading-snug text-subtle">{{ option.note }}</span>
                                <!-- The allowance is spent, and saying so beats hiding a rung the reader was
                                     offered on their first sandbox. -->
                                <span v-if="option.value === `hosted` && hostedSpent" class="text-xs text-warning">Already using yours</span>
                            </button>
                        </div>
                    </div>

                    <section v-if="created && lane === `provision`" class="ui-card flex flex-col gap-4 p-4 md:p-5">
                        <!-- WHERE THIS MACHINE WILL ANSWER: the rung's consequence, reported by the card the rung
                             chose. It spent a release as the second line of the sandbox card, which put a hex
                             hostname above the only decision on the page and made a stranger skip it to reach the
                             choice. Down here it is read by somebody who has already picked, next to the command
                             that carries it, and each rung's answer is the one that belongs to that rung: a hosted
                             machine announces its own, this platform may hand out none, the default is minted from
                             the connect token, and the last is a Cloudflare zone of the reader's: the only one
                             that is a FORM rather than a fact, which is why it takes the whole block instead of a
                             row in it.
                             It leads the card in every lane, so "the token above", "the address above" and the
                             lock's "Preparing your intentic domain…" all point at something on screen. -->
                        <div class="flex flex-col gap-2">
                            <!-- ONE GROUP IN EVERY STATE (announced, minted, still minting, failed, or never
                                 offered) so the escape hatch beside it is reachable in all of them. It used to
                                 hang off the success branch alone, which left a reader whose mint had just
                                 errored with no way to choose a different address at all. -->
                            <div v-if="addressFact !== `own`" class="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
                                <span :class="factLabel">Address</span>
                                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                    <!-- A hosted sandbox's address is the daemon's own announce: no mint, no
                                         escape hatches: the machine is born holding its tunnel, and the page
                                         redirects the moment this turns real.
                                         KEYED ON THE RUNG, NOT ON THE MACHINE. Now that choosing that rung starts
                                         nothing, there is a stretch with the hosted lane selected and no machine
                                         behind it, and read off the machine, this fell through to the mint's
                                         spinner and promised a domain that lane never asks for. A spinner before
                                         the button is pressed is the same lie the addressless platform used to
                                         tell. -->
                                    <template v-if="addressFact === `hosted`">
                                        <span v-if="hostedHost" :class="`${factSlot} break-words`">{{ hostedHost }}</span>
                                        <span v-else-if="hostedRow !== null" :class="`${factSlot} gap-2 text-xs text-muted`">
                                            <Icon name="spinner" spin /> Assigned as your machine starts…
                                        </span>
                                        <span v-else :class="`${factSlot} text-xs text-muted`">Assigned when your machine starts</span>
                                    </template>
                                    <!-- THE PLATFORM MINTS NO ADDRESSES: a fact, not a wait, so it gets neither a
                                         spinner nor the escape hatch (both ways off the default address mint a code
                                         too, so both are the same dead end here). -->
                                    <span v-else-if="addressFact === `none`" :class="`${factSlot} text-xs text-muted`">
                                        This platform doesn't set one up
                                    </span>
                                    <template v-else>
                                        <!-- `.title`: this is a NoticeModel, and interpolating the object itself
                                             put its JSON on the card. -->
                                        <span v-if="setupError" :class="`${factSlot} text-xs text-danger`">{{ setupError.title }}</span>
                                        <span v-else-if="setup" :class="`${factSlot} break-words`">{{ setup.hostname }}</span>
                                        <span v-else :class="`${factSlot} gap-2 text-xs text-muted`">
                                            <Icon name="spinner" spin /> Preparing your intentic domain…
                                        </span>
                                        <!-- ONE ESCAPE HATCH, NOT TWO. "Use my own Cloudflare zone instead" and
                                             "Already reachable at a domain? Connect it" were two links, in two
                                             places, asking the same question: how should this be reached, and the
                                             reader had to know the difference between provisioning under their zone
                                             and attaching an address that already answers BEFORE they could tell
                                             which link was theirs. Now one link opens both, each stating what it
                                             does rather than what it is called. -->
                                        <button type="button" :class="ui.linkButton()" @click="reaching = !reaching">
                                            {{ reaching ? `Keep this address` : `Use a different address` }}
                                        </button>
                                    </template>
                                </div>
                            </div>

                            <!-- What the row could not say on its own line, under it rather than in it: this
                                 platform hands out no addresses, so here is the one thing that does work, and the
                                 two ways off the default one, opened by the link above. They were rows in a
                                 bordered inset with a caption each: a second frame, inside a card, to hold two
                                 choices that fit on one line. The labels carry the distinction, which is the only
                                 thing the captions were for. -->
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

                            <!-- Own Cloudflare: token + zone + editable subdomain. The way back sits on a row with
                                 the (i) that explains the token, which is the corner the step header used to keep
                                 it in: this card has no header to hang it off any more. -->
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

                                <!-- Editable domain: the subdomain prefix under the chosen zone. The zone suffix wraps
                                     to its own line rather than stealing width from the one part that is editable: an
                                     account's zone can be long, and on a phone the two together left no field to type
                                     in. -->
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
                                            :class="ui.input('w-full text-base md:w-auto md:min-w-0 md:flex-1 md:text-sm')"
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

                        <!-- Whatever went wrong on THIS step, said on this step. Keeping it separate from the
                             arrival notice prevents a lane change from erasing the reason. -->
                        <Notice v-if="hostedError" :of="hostedError" />

                        <!-- THE HOSTED WAIT. Nothing to run and nothing to copy: the platform is doing the work
                            , but "the platform is doing the work" was the entire message for every one of the
                             several minutes it can take, and for every way it can fail. A spinner is honest
                             about there being nothing to DO; it was never honest about there being nothing to
                             KNOW, and people sat through a wedged tunnel because the page could not tell them
                             apart from a slow boot.

                             So: the steps, ticking, while it is going fine, or what broke and what happens
                             next, when it isn't. Never both (hostedWait.ts owns that decision, the way
                             setupReport.ts owns step 2's). -->
                        <template v-if="machine === `hosted`">
                            <template v-if="hostedRow !== null">
                                <!-- The diagnosis. The step list is deliberately gone from underneath it: a
                                     list still ticking beside "here is what broke" is the page arguing with
                                     itself, and the reader has one thing to decide, not two to reconcile. -->
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
                                <!-- …and the healthy wait: one row per step, the current one named and
                                     spinning. Four short lines that say where we are beats one sentence that
                                     says it is happening. -->
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
                                    <!-- The promise under the list is the view's (hostedWait.ts): the estimate
                                         this machine's origin earns, then: once minutes are on the clock:
                                         how many, so a long download reads as counted work, never as a hang. -->
                                    <p class="text-xs text-muted">{{ hostedWait.note }}</p>
                                </template>
                            </template>
                            <p v-else-if="hostedBusy" class="flex items-center gap-2 text-xs text-content">
                                <Icon name="spinner" spin class="text-info" />
                                Starting a machine for you…
                            </p>
                            <!-- NOTHING HAS BEEN CREATED YET, AND THIS IS THE THING THAT CREATES IT. The rung
                                 above is a description; this is the commitment, which is why the one fact about
                                 this machine that changes what a reasonable person does: its disk is ours and we
                                 do not back it up: is stated HERE, where somebody is deciding, rather than as
                                 small print under a picker they were only reading.
                                 `hostedError` above already says why a previous attempt failed, so this doubles
                                 as the retry without having to call itself one. -->
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
                        </template>

                        <!-- The command carries the chosen path's values, so we don't reveal it until that path is ready: a
                     command missing the token/zone/subdomain or the provisioned tunnel would just fail in the sandbox.
                     A FAILED mint gets a notice and a retry instead of the dashed placeholder: "Preparing your
                     intentic domain…" that never resolves is the state that made this page read as broken, and
                     the reader could neither see the reason (it was two cards up, in the address row) nor do
                     anything about it. -->
                        <template v-else-if="!commandReady">
                            <template v-if="setupError">
                                <Notice :of="setupError" />
                                <Button label="Try again" class="w-full justify-center md:w-fit" @click="remint">
                                    <template #icon><Icon name="refresh" /></template>
                                </Button>
                            </template>
                            <!-- The theme's own "a place for something rather than a thing" surface
                                 (`ui-card-dashed`), not a hand-drawn dashed rectangle: one waiting-room look,
                                 dressed by whichever skin is on. -->
                            <div v-else class="ui-card ui-card-dashed flex items-start gap-2 p-3 text-xs text-muted">
                                <Icon name="lock" class="mt-0.5 shrink-0" />
                                <span>{{ lockedReason }}</span>
                            </div>
                        </template>
                        <template v-else>
                            <template v-if="machine === `cloud` && cloudOffered">
                                <!-- The machine boots headless with no Cloudflare of its own, so only the
                                     intentic-provided tunnel can make it reachable: a step-2 own-zone pick has
                                     to be walked back before the form is any use. -->
                                <p v-if="mode !== `intentic`" class="flex items-start gap-2 text-xs text-muted">
                                    <Icon name="info-circle" class="mt-0.5 shrink-0" />
                                    <span>Cloud machines use intentic's domain. Switch the address above back to intentic's to create one.</span>
                                </p>
                                <!-- Provisioned: the form's work is done, and the one fact worth keeping on screen
                                     is where the machine lives: the wait below narrates the rest. -->
                                <p v-else-if="cloudMachine" class="flex items-start gap-2 text-xs text-muted">
                                    <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                                    <span class="min-w-0">
                                        <span class="text-content">{{ cloudMachine.serverName }}</span> was created in your
                                        {{ cloudProviderName }} account ({{ cloudMachine.location }}). It sets itself up from first boot.
                                    </span>
                                </p>
                                <SetupCloud v-else-if="created" :sandbox-id="created.id" @provisioned="onProvisioned" />
                            </template>
                            <template v-else>
                                <!-- Inside the desktop app the terminal is gone: one click hands this same setup code to the
                                 app, which runs the same connect script on this machine and streams what it says into
                                 its manager window. So in the app this IS the step: a line of consequence, the button
                                 that causes it, and a way out for someone who wanted a server after all.
                                 It used to be a tinted, bordered panel carrying its own "Run it on this computer"
                                 heading with a primary button inside: the step title, the panel heading and the button
                                 label all saying the same sentence, three boxes deep, inside a card that already has a
                                 border. The title above names the machine, so the button only has to name the verb:
                                 which is also the shape the app's other two handoffs use (HostRecreate, the
                                 environment card), and there is no reason onboarding should be the loud one. -->
                                <template v-if="desktop">
                                    <p class="text-xs text-muted">
                                        Installs Docker if you need it, starts your sandbox and its tunnel, and opens your workspace the moment it
                                        answers. No terminal.
                                    </p>
                                    <Button label="Set it up now" class="w-full justify-center md:w-fit" @click="runHere">
                                        <template #icon><Icon name="bolt" /></template>
                                    </Button>
                                </template>

                                <!-- …and in a browser, the same answer one install earlier: the app, for the
                                     machine this reader is on. One button and nothing else: the sentence that
                                     would sell it is the sentence the reader is already deciding without, and the
                                     app's own first screen is the branch above, where the button finishes the job.
                                     `secondary` is deliberately NOT used here: this is the step, and the only
                                     other thing on the card is a muted link.
                                     `w-fit` AND NOT `w-auto`, which every primary on this page now shares: the
                                     card is a flex COLUMN, so a child whose cross size is `auto` is stretched to
                                     its width no matter what `w-auto` asks for, and the button meant to be as
                                     wide as its label came out as a 760px bar of accent across the card. A
                                     definite width opts out of the stretch; `self-start` also would, but it
                                     silently top-aligns the same class used in a flex row. -->
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

                                <!-- On a phone, the step's actual next move: see SetupHandoff.vue. It goes ABOVE the
                                 command because the command is the thing it is redirecting people away from, and a
                                 correction printed underneath what it corrects is read second or not at all. It is
                                 no longer gated on the command being on screen: it is what the step IS here, and the
                                 command is the thing folded behind it. -->
                                <SetupHandoff v-if="mobile && created" :sandbox-id="created.id" :email="user?.email ?? ``" @sent="onEmailed" />

                                <!-- ONE ROW OF ALTERNATIVES, NOT A STACK OF DISCLOSURES. There were two, one under
                                     the other, each opening with a question: "Can't run it on this computer? See
                                     the other options" over "Running it on a server instead? Show the command".
                                     Two chevrons under the one button that matters, asking the reader to work out
                                     which of two overlapping questions was theirs (a server IS another computer),
                                     and each promising only to reveal something rather than naming it.
                                     They are not the same KIND of thing, which is why folding them into one
                                     disclosure would have been wrong too: the first changes WHERE the sandbox runs
                                     (a machine we host, or one in the reader's own cloud account), the second
                                     changes HOW this one is started (a command instead of a button). So: one quiet
                                     line saying these are the alternatives, and each alternative named by its
                                     outcome. Nothing to open to find out what is on offer, and neither one wearing
                                     the weight of a second call to action. -->
                                <nav
                                    v-if="desktop || mobile || appFirst"
                                    aria-label="Other ways to set up"
                                    class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"
                                >
                                    <span>Other ways to set up:</span>
                                    <!-- The rungs the app keeps folded away, opened by name. Only in the app: in a
                                         browser they are already on screen, and a link offering what the reader can
                                         already see sends them looking for something else. -->
                                    <template v-if="desktop && !elsewhere && (addressed || hostedOffer?.enabled)">
                                        <button type="button" :class="ui.linkButton()" @click="showOtherMachines">
                                            Use a hosted or cloud machine
                                        </button>
                                        <span aria-hidden="true" class="text-subtle">·</span>
                                    </template>
                                    <button type="button" :class="ui.linkButton()" @click="showCommand = !showCommand">
                                        <template v-if="showCommand">Hide the command</template>
                                        <template v-else-if="desktop">Show the command for a server</template>
                                        <template v-else>Show the command</template>
                                    </button>
                                </nav>

                                <div v-if="commandVisible" class="flex flex-col gap-2">
                                    <!-- One line, because the title already gave the instruction and nobody reads the second
                             sentence of a step they are trying to get through. All this adds is the bit the title
                             can't: WHICH machine, which is why it belongs to the COMMAND and not to the step, and
                             why it is no longer above a button whose whole selling point is that there is no
                             terminal. In the app (where this computer already has a button of its own) the machine
                             that runs this is by construction not the one reading it.
                             Not on a phone: the line that opened this disclosure already said who copying is for,
                             and repeating it here would be the third sentence in a card about a fourth device. -->
                                    <p v-if="!mobile" class="flex items-start gap-2.5 text-xs text-muted">
                                        <Icon name="terminal" class="mt-0.5 shrink-0 text-link" />
                                        <span class="min-w-0">
                                            <template v-if="desktop"
                                                >Copy it, then paste it into a terminal on the machine that will host your sandbox.</template
                                            >
                                            <template v-else>Paste it into a terminal: this computer, or any server you have a shell on.</template>
                                        </span>
                                    </p>
                                    <!-- On a phone the picker takes a full row of its own: three pill tabs sharing a
                             340px line wrapped every label to two lines. The copy button leaves that row with
                             it: a chip stranded on a line of its own under the tabs, one row above the thing
                             it copies, was the loose end on this card. Beside the tabs on a desktop, under the
                             command on a phone; either way it is next to what it acts on. -->
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
                                        <!-- Clamped on a phone: the command is a thing to COPY, and wrapped in full it is
                                 nine lines of env vars between the button that copies it and the step that
                                 comes next. The dev command is the long one, but even the hosted one-liner
                                 wraps to four lines at 390px.
                                 No label. It read "Terminal", to stop a dark monospace box being taken for a
                                 documentation snippet, but the line above the block already says to paste this
                                 into a terminal, so it was a heading restating the sentence directly above it,
                                 and a row of chrome between the Copy button and the thing it copies. -->
                                        <Code
                                            :code="selectedCommand"
                                            :lang="selectedCommandLang"
                                            :wrap="true"
                                            :copyable="false"
                                            :clamp-lines="mobile ? 4 : undefined"
                                        />
                                        <!-- Full width and touch-sized, directly under the command: the reader who
                                 opened this disclosure came for the clipboard, so here, and only here: copying
                                 is the action. `secondary`, because the primary on this card is the email
                                 handoff above it and two filled buttons make the reader choose twice. -->
                                        <CopyButton
                                            v-if="mobile"
                                            :text="selectedCommand"
                                            label="Copy command"
                                            :stretch="true"
                                            severity="secondary"
                                            @copied="onCopied"
                                        />
                                        <!-- Local dev only: platformEnv() injects SANDBOX_IMAGE=intentic-sandbox:dev, connect.sh
                                 rebuilds it from this checkout on every run (layer-cached), so the pasted command is
                                 self-sufficient and never runs a stale image after sandbox edits. Folded shut: it is a
                                 note to whoever is developing intentic itself, not a step in setting a sandbox up.
                                 Gated on the same condition as the tag it describes: asked for the released script,
                                 this command builds nothing, and a note promising otherwise would be the only thing
                                 on screen still claiming it. -->
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

                                <!-- THE ONE SWITCH THAT IS A DECISION, UNDER THE COMMAND IT REWRITES. `sudo` is a
                                 claim about the reader's own machine, and its answer is visible in the line one
                                 row up, so it stays where the line is. Desktop sync used to sit beside it and no
                                 longer does: it is on unless somebody objects, and a default at full contrast
                                 beside a command reads as a second question to settle before pasting. It lives in
                                 the reference column now (and, where there is no column, under the command).
                                 Unix only, because `sudo` is: PowerShell has no equivalent to drop, so on Windows
                                 there is no switch here and the Docker prerequisite is left to the panel, which
                                 names the reboot a first Windows install may want. And only while the command is
                                 on screen: it rewrites one token of a line, which is no kind of offer when the
                                 line itself is folded away.
                                 The <label> stops at the option's NAME rather than wrapping the row: a label
                                 toggles on any click inside it, and the caption beside it mentions `sudo`: text
                                 people select and read. -->
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

                                <!-- …and sync itself, for the widths with no reference column to put it in. Sync
                                     outlives the command in the APP, where it rides the desktop handoff too, so it
                                     survives the command being folded away there. Only the compose tab drops it
                                     outright: that file declares its own env. -->
                                <SetupSyncOption v-if="syncOffered" v-model="syncEnabled" :folder="syncDir" class="xl:hidden" />
                            </template>
                        </template>

                        <!-- The wait's whole job, as the footer of the step it reports on: now saying WHICH of the two
                     waits this is. A spinner from the moment a code was minted is what made a screen where the
                     user has done nothing look identical to one where Docker is four minutes into an image
                     pull, and "your workspace opens automatically" is a promise about the second that reads, in
                     the first, as permission to sit still.
                     So the icon leads, and it SPINS IN EVERY STATE, because in every state something is
                     genuinely running: the registry poll, every 3s, for as long as this card is on screen.
                     The idle state used to get a static dot instead, to keep a spinner from claiming progress
                     the platform wasn't making, but that reads as a page that has stopped, and the fix for
                     "the platform is doing this for you" belongs in the WORDS, which is where it is now: the
                     line names the person whose move it is. Colour carries the difference the spin doesn't:
                     subtle while we're waiting on the user, info once it's out of their hands, success once a
                     machine has it.
                     There is no "Check now" here any more. The registry is polled every 3s regardless, so the
                     button re-asked a question already being asked and bought nothing but its own presence:
                     and because the poll shares `checking`, it spent every third second flipping itself to
                     "Checking…" and back, which is a card that looks broken while it works perfectly. -->
                        <div v-if="waiting" class="flex flex-col gap-2">
                            <!-- The spinner is a promise that something is moving, so it does not survive a failure
                                 report: a spinner beside "here is what broke" is the page contradicting itself. -->
                            <p
                                v-if="reportFailures === null"
                                class="flex items-start gap-2 text-xs"
                                :class="handoff === `claimed` ? `text-content` : `text-muted`"
                            >
                                <Icon
                                    name="spinner"
                                    spin
                                    class="mt-0.5 shrink-0"
                                    :class="handoff === `claimed` ? `text-success` : handoff === `handed` ? `text-info` : `text-subtle`"
                                />
                                <span class="min-w-0">
                                    <!-- The machine narrating its own stage beats the canned guess: "Starting
                                         Docker" was written when this page knew nothing after the claim. -->
                                    <template v-if="handoff === `claimed` && buildStage !== undefined">
                                        <span class="font-medium text-success">Your machine picked it up.</span> Right now: {{ buildStage }}.
                                    </template>
                                    <template v-else-if="handoff === `claimed`">
                                        <span class="font-medium text-success">Your machine picked it up.</span> Starting Docker. The first run takes
                                        a few minutes.
                                    </template>
                                    <!-- Handed off three ways, and the next move differs: a copied command still has to
                                         be pasted, the app already has everything and is opening its own window, and a
                                         cloud machine is booting with nothing left for anyone to do. -->
                                    <template v-else-if="handoff === `handed` && cloudMachine">
                                        <span class="font-medium text-content">Machine created.</span> Its first boot installs Docker and your
                                        sandbox, usually a few minutes. This page opens your workspace the moment it answers.
                                    </template>
                                    <template v-else-if="handoff === `handed` && launched">
                                        <span class="font-medium text-content">Handed to the app.</span> Follow it in the Intentic window. This page
                                        opens your workspace the moment it answers.
                                    </template>
                                    <template v-else-if="handoff === `handed`">
                                        <span class="font-medium text-content">Copied.</span> Paste it into that terminal and press Enter.
                                    </template>
                                    <!-- "Nothing is running yet" described the SANDBOX and told the reader nothing
                                         they could act on: the one fact this state has is whose move it is, so
                                         it says that instead. In the app there is no command to name and the
                                         button has a label, so it names the button. -->
                                    <template v-else-if="machine === `cloud` && cloudOffered">
                                        <span class="font-medium text-content">Waiting for you to create the machine.</span> Paste a credential above,
                                        then create it: nothing runs, or costs anything, until you do.
                                    </template>
                                    <template v-else-if="desktop && !commandVisible">
                                        <span class="font-medium text-content">Waiting for you to start it.</span> Nothing runs until you press "Set
                                        it up now" above.
                                    </template>
                                    <!-- The same sentence for the browser that was offered an installer: naming the
                                         app's button here would name one this reader hasn't got yet. -->
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

                            <!-- The correction, on a timer, and NOT here on a wide screen, where it rides in the
                                 reference column instead (see the aside below). At the foot of this card it was
                                 the furthest thing on the page from the command it corrects: three tabs, a code
                                 block, two switches and a wait line above it, on a card long enough to scroll. -->
                            <SetupNudge
                                v-if="nudging"
                                class="xl:hidden"
                                :variant="nudgeVariant"
                                :cloud-name="cloudMachine?.serverName ?? ``"
                                :cloud-provider="cloudProviderName"
                                :stalled="stalled"
                                :command="selectedCommand"
                                :copyable="nudgeCopyable"
                                @copied="onCopied"
                            />

                            <!-- A claim with no daemon behind it is a genuinely different failure from silence: the
                         command ran, so the terminal is where the answer is. Much longer fuse: the first image
                         pull legitimately takes minutes. -->
                            <p v-if="slowBuild" class="flex items-start gap-2 text-xs text-warning">
                                <Icon name="exclamation-circle" class="mt-0.5 shrink-0" />
                                <!-- Where the answer is depends on what actually ran it: the app streams its own
                                     log, everything else has a terminal. Asking `commandVisible` instead used to
                                     send a phone whose command is folded away to an app window that only exists on
                                     a desktop. -->
                                <span class="min-w-0"
                                    >Picked up a while ago, still no sandbox. Check
                                    {{
                                        launched
                                            ? `the Intentic window`
                                            : cloudMachine
                                              ? `the machine's boot log in your ${cloudProviderName} console`
                                              : `that terminal`
                                    }}
                                    for an error. It's safe to re-run.</span
                                >
                            </p>
                        </div>
                        <p v-if="status" class="text-xs text-warning">{{ status }}</p>
                    </section>
                </div>

                <!-- The docked half of the run step's reference material (SetupRunDetails carries the reasoning).
                     Present only while the run step is, because it is that step's material and nothing else's: the
                     attach lane runs no command and has nothing to explain here. `hidden` below xl: the same
                     content is on the run step's (i) hint there, and the hint's trigger is `xl:hidden` in turn, so
                     exactly one of the two is reachable at any width.
                     The width is measured, not picked: 22rem is what the longest cleanup one-liner (the sh
                     one, 44 mono characters at text-xs) needs to sit on a single line inside the card's
                     padding. At 18rem it wrapped into three lines: the undo read as a paragraph. -->
                <aside
                    v-if="created && lane === `provision` && machine !== `hosted`"
                    class="hidden flex-col gap-3 xl:sticky xl:top-8 xl:flex xl:w-88 xl:shrink-0"
                >
                    <div class="ui-card flex flex-col gap-3 p-4">
                        <SetupRunDetails :cleanup="cleanupCommand" :downloads="!appFirst" />
                        <!-- Sync belongs with what the command DOES, not with the reader's path to running it:
                             it is on by default, and the only thing anyone needs from it here is to see that it
                             is on and where it mirrors to. Its twin under the command covers the widths where
                             this column doesn't exist.
                             Gated on the command existing, exactly as that twin is by the branch it sits in: the
                             folder it names is derived from the address the mint provisions, so before there is
                             a command there is nothing here to be true. -->
                        <SetupSyncOption v-if="syncOffered" v-model="syncEnabled" :folder="syncDir" class="pt-1" />
                    </div>
                    <!-- …and the correction as the second card in this column, once the wait has gone on long
                         enough to be a misunderstanding rather than a wait. It belongs beside the command, and
                         this column is the only place on a wide screen that is beside anything. -->
                    <SetupNudge
                        v-if="nudging"
                        :variant="nudgeVariant"
                        :cloud-name="cloudMachine?.serverName ?? ``"
                        :cloud-provider="cloudProviderName"
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
