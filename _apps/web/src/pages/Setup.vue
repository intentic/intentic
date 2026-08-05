<script setup lang="ts">
import type { SandboxSummary, SetupCode, SetupCodeTarget } from "@intentic-app/api-contract";
import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { sandboxSubdomain, syncFolder } from "@intentic/sandbox-contract";
import { cmp, Code, commandLang, CopyButton, InfoHint, Segmented, StepSection, useDevice, useOsPreference } from "@intentic/ui";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { track } from "../composables/analytics";
import { apiClient } from "../composables/useApi";
import { errorMessage } from "../composables/useAsyncAction";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { useNow } from "../composables/useNow";
import CloudflareTokenField from "../components/CloudflareTokenField.vue";
import { useCloudflareZones } from "../composables/extensions/useCloudflareZones";
import { sandboxIdFromToken } from "../composables/sandbox/sandboxIdFromToken";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { DESKTOP_DOWNLOADS, desktopSetupLink, desktopVersion, openDesktopLink } from "../environments/desktop";
import { environment } from "../environments/environment";
import { bashCommand, psCommand } from "../environments/scriptCommand";
import SetupCompose from "./SetupCompose.vue";
import SetupHandoff from "./SetupHandoff.vue";
import SetupRunDetails from "./SetupRunDetails.vue";
import type { ComposeArgs } from "./setupCompose";
import { type AttachOutcome, daemonUrlProblem, nameFromDaemonUrl, normalizeDaemonUrl, probeDaemon } from "./setupAttach";

/* The setup gate's destination (outside the workspace shell). Step 2 offers two ways to make the sandbox reachable:
 *   • intentic-provided (default): the platform provisions a Cloudflare tunnel under its OWN zone; the user needs no
 *     Cloudflare of their own. The subdomain is fixed (server-derived from the connection token).
 *   • own Cloudflare: the user pastes their token, picks a zone, and edits the subdomain; the sandbox creates its own
 *     tunnel. The token only reaches the platform for a request-scoped zone listing, then is dropped — on this path it
 *     rides the command as a CF_TOKEN env var, never stored.
 * Either way the platform mints a SHORT-LIVED SETUP CODE (sandbox.setupCode) for the chosen target; the copy-paste
 * command carries only that code and the connect script redeems it at POST /setup/claim for the real values — so no
 * raw token lands in shell history. Step 3 also offers desktop sync (on by default): the choice + folder ride the
 * same code (SYNC_DIR + a platform-minted single-use SYNC_PAIR_TOKEN in the payload), so the one pasted command
 * additionally enrolls the sync agent after the sandbox boots — no second paste. Once running, the DAEMON announces
 * its URL + liveness to the platform; this page just polls sandbox.list for a fresh lastSeenAt and then opens the
 * workspace — the browser never resolves the sandbox hostname here, so no DNS race can wedge setup. That wait is
 * step 3's own footer rather than a fourth step: it asks the user for nothing, so a card of its own was chrome
 * around one sentence, and the sentence belongs under the command whose result it is reporting.
 *
 * Step 3 is also where the flow is most often abandoned — not because a pasted command does more than an .msi
 * would, but because it shows up without any of an installer's affordances. So the card states what will be
 * created, what it writes outside Docker and how to remove all of it, and offers the one switch that reshapes
 * the command instead of leaving the reader to abandon it: `hasDocker` (drop the `sudo`, which is only ever there
 * to install Docker).
 *
 * That is the PROVISION lane. There is a second, one-step ATTACH lane for a user whose sandbox is already running
 * behind a domain of their own: they paste the address, the browser probes it (setupAttach.ts), and sandbox.attach
 * records it — no tunnel to provision, no command to run, no announce to wait for, so steps 2-3 never render.
 * `lane` decides which spine step 1 is the head of.
 *
 * The two lanes SHARE their state rather than mirroring it. Everything a lane owns is genuinely lane-specific
 * (the reachability target, the command, the sync opt-in vs. the domain and the probe outcome); everything about
 * the sandbox itself — its `name` and its `created` row — is one value read by both. That is what makes a lane
 * switch lossless in either direction at any point: a name typed before switching survives, and a row created by
 * an attach whose probe passed but whose attach then failed continues as the provision lane's sandbox instead of
 * being stranded. `targetKey` is gated on the lane for the same reason in reverse — minting is what buys the
 * Cloudflare tunnel, and an attached sandbox is reached over the user's own domain, so it must not mint. */

const sandbox = useSandbox();
const router = useRouter();
const route = useRoute();
// A phone gets a DIFFERENT step 3, not a narrower one — the command runs on a machine this browser is not, so
// the handoff is the step and the command folds behind a disclosure (see `commandVisible`). The rest of what
// this drives is content the md: classes below cannot reach: the run tabs' labels, and the size and emphasis
// of the controls that carry them.
const { mobile } = useDevice();
const { user, entitlements, refreshPlan } = useAuth();
const { getIdToken, warmIdToken } = useGoogleIdentity();

// The sandbox created in this setup session (holds its connection token). Null until the user names + creates it.
const created = ref<SandboxSummary | null>(null);
// True when we arrived via ?sandbox=<id> and resumed an existing sandbox (vs. created one here now).
const resuming = ref(false);
const name = ref(``);
const creating = ref(false);
const error = ref<string | null>(null);

// Whether the account is at its owned-sandbox cap — mirrors the server gate (router.ts) and the switcher
// preflight, so nobody fills in a name for a Create that could only 402.
const atLimit = computed(() => {
    const limit = entitlements.value?.sandboxLimit;
    return limit !== undefined && sandbox.sandboxes.value.filter((entry) => entry.role === `owner`).length >= limit;
});

// Is there a workspace to go BACK to — some sandbox other than the one being set up here that has actually
// reported in. Both halves matter: a row this page created moments ago is not somewhere to return to, and
// neither is one that has never had a daemon (its shell would open on a connecting gate that never resolves).
const otherWorkspace = computed(() => sandbox.sandboxes.value.some((entry) => entry.id !== created.value?.id && entry.lastSeenAt !== null));

// Step 2 mode. Default is the zero-config intentic-provided path; "own" is the bring-your-own-Cloudflare toggle.
const mode = ref<"intentic" | "own">(`intentic`);
// Whether the intentic-provided path is offered at all (false once its mint 404s — the server feature flag).
const intenticAvailable = ref(true);

// --- setup code state (both paths) ---
// The minted {code, hostname, expiresAt} for the currently chosen target; the command carries only the code.
const setup = ref<SetupCode | null>(null);
const setupError = ref<string | undefined>(undefined);
// The target key `setup` was minted for, so watcher re-fires don't re-mint and a stale mint is discarded.
const mintedFor = ref<string | undefined>(undefined);
let mintTimer: ReturnType<typeof setTimeout> | undefined;

// --- own-Cloudflare path state ---
// Token + zone discovery is shared with the in-app Connect Cloudflare step (useCloudflareZones). Here it only
// feeds the setup-code target — on this path the token rides the install command, it isn't written to .env.
const cf = useCloudflareZones();
const { cfToken, cfTokenValid, selectedZone, zonesLoading, zonesError } = cf;
// Zones are domains — monospace rows behind a filterable picker, since an account-wide token can carry dozens.
// The editable subdomain prefix, pre-filled with the derived `sandbox-<hash>` default (so an untouched field
// reproduces the CLI's default). The full hostname is `<subdomain>.<selectedZone>`.
const subdomain = ref(``);
const derivedPrefix = ref(``);
const subdomainValid = computed(() => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(subdomain.value.trim()));

// --- desktop sync opt-in (step 3) ---
// On by default: the same pasted command also enrolls the sync agent. The folder rides the command as a
// SYNC_DIR env var (a path, not a secret), so toggling this just adds/removes it — no re-mint. The folder is
// derived from the sandbox name AND the hostname the mint just provisioned (not user-editable) — shown as
// info, not a field — so it carries the same id the sandbox's address does. Empty until the mint lands, which
// is also when the command that would carry it appears.
const syncEnabled = ref(true);
const syncDir = computed(() => (created.value && setup.value ? syncFolder(created.value.name, setup.value.hostname) : ``));

// --- attach lane (step 1's one-step alternative) ---
// Which spine step 1 heads: `provision` (reachability → run → wait, steps 2-4) or `attach` (paste the domain
// the sandbox is ALREADY reachable at → verify → workspace), which finishes inside step 1 itself.
//
// Both lanes work on the SAME `name` and the SAME `created` row — a sandbox's name and identity are facts about
// the sandbox, not about how the user chose to reach it. Duplicating either into lane-local state is what makes
// a lane switch lose typing, so there is deliberately no `attachName`/`attachRow` here.
const lane = ref<"provision" | "attach">(`provision`);
const domain = ref(``);
// The connection token the daemon was started with, revealed only after a `needs-token` probe. Used for that
// one first-bind request and never persisted — the daemon stops caring the moment an owner is bound, so the
// platform has no reason to hold a copy (same posture as the Cloudflare token above).
const attachToken = ref(``);
const attaching = ref(false);
const attachOutcome = ref<AttachOutcome | undefined>(undefined);

const normalizedDomain = computed(() => normalizeDaemonUrl(domain.value));
const domainProblem = computed(() => daemonUrlProblem(domain.value));
// What a bare paste would be named, so the attach lane can ask for the domain and nothing else. It only ever
// fills the field's PLACEHOLDER — a name the user actually typed (in either lane) always wins.
const derivedName = computed(() => (normalizedDomain.value === undefined ? `` : nameFromDaemonUrl(normalizedDomain.value)));
const attachedName = computed(() => (name.value.trim() === `` ? derivedName.value : name.value.trim()));

// Step 1 collapses to a summary once the sandbox exists — its title carries the name — in both lanes: an
// already-named row is why the attach lane stops asking for a name at all.
// A resumed sandbox that has ACTUALLY run before is being reconnected; one that was named and never started is
// just being picked back up, and calling that "Reconnect" claims a history it doesn't have.
const neverStarted = computed(() => created.value !== null && created.value.lastSeenAt === null);
const step1Title = computed(() => {
    if (created.value !== null) {
        return resuming.value && lane.value === `provision` && !neverStarted.value ? `Reconnect "${name.value}"` : `Sandbox: ${name.value}`;
    }
    return lane.value === `attach` ? `Connect your sandbox` : `Name your sandbox`;
});

// Step 3 shows one command at a time; the preferred OS is a persisted singleton shared across screens.
const { cmdOs } = useOsPreference();

// The third Run tab: manage the sandbox with the user's own docker-compose.yml instead of the install
// script. Local state layered over the persisted OS preference — picking Compose must not overwrite the
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
// The third tab is on a different axis from the first two — it is not another OS, it is the path for someone
// who would rather read a file than run a script — and its label can't say so without outgrowing the row. The
// title says it on a desktop and the panel's own first line says it everywhere, which is where the reader who
// needs it actually arrives.
const runTabOptions = computed(() => [
    { label: `Linux / macOS`, value: `unix` as const },
    { label: mobile.value ? `Windows` : `Windows (PowerShell)`, value: `windows` as const },
    {
        label: mobile.value ? `Compose` : `Docker Compose`,
        value: `compose` as const,
        title: `No script runs — read the whole file, then start it yourself`,
    },
]);

/* The one control over the SHAPE of the pasted command. It exists because a copy-paste install is the point
 * people balk at — not because it does more than an .exe would, but because it arrives with none of an
 * installer's affordances: no publisher, no preview, no file list, no uninstaller.
 *
 * `hasDocker` drops the `sudo`. It is in there for exactly one job — installing Docker when the machine has
 * none (connect.sh's require_root_to_install_docker states the same deal from the other side) — and for a
 * developer who already runs Docker it is the single most alarming token in the line. Not persisted: it is a
 * claim about the machine the user is about to paste into, which is not necessarily the one they are reading on.
 *
 * It used to have a peer — a `review` switch that split the one-liner into download-it, read it, then run the
 * file. It was removed because it read as a WARNING rather than an offer: a checkbox telling you to read
 * something before running it is an admission that running it is unsafe, on the one step where hesitation is
 * what loses people. The reference panel already says what the command creates and how to undo it, and the
 * desktop app is the real answer for anyone who wants an installer instead of a pipe. */
const hasDocker = ref(false);

/* THE THIRD WAY TO RUN STEP 3 — the desktop app (_apps/desktop), when this page is being read INSIDE it.
 *
 * It is the same handoff the command is: the app claims this same setup code and runs the same connect
 * script, so nothing about steps 1-2 or the announce-watch below changes. What it removes is the terminal —
 * which is what people actually balk at here, and what the two switches above can only soften.
 *
 * So inside the app step 3 IS that button, not a second offer beside a command: one line of consequence, the
 * button, and a link for the person who wanted a server after all. Everything below that belongs to the
 * COMMAND rather than to the step — the paste-it-into-a-terminal line, the `sudo` switch, "Copy again" —
 * is gated on the command actually being on screen, because in the app it usually isn't.
 *
 * A browser that is NOT the app still gets the link (the OS routes it to an installed app) plus somewhere to
 * download one; the pasted command stays the primary path there, because it is the one that always works. */
const desktop = computed(() => desktopVersion() !== undefined);
/* THE COMMAND IS FOLDED AWAY ON THE TWO DEVICES WHERE IT IS NOT THE PATH, behind the same one-line disclosure
 * on both: in the app the button above already runs it (a server is still an ordinary place to want the
 * sandbox, and the app cannot run it there), and on a phone there is no shell to paste into — the handoff is
 * the step there, and the command under it was six controls of scenery around a clipboard write that leads
 * nowhere. Neither reader is shut out: a phone driving a server over SSH is one tap from the same command,
 * and the tap is labelled for exactly that person. Everywhere else the command IS the step, and there is
 * nothing to unfold. */
const showCommand = ref(false);
const commandVisible = computed(() => (desktop.value || mobile.value ? showCommand.value : true));
// Compose declares its own env, so neither switch under the command applies to it — but "no tab is on screen
// at all" is a different thing from "the compose tab is", and only the second one hides the sync option.
const composeShown = computed(() => commandVisible.value && runTab.value === `compose`);
// The step names the machine, because "run this" alone reads as something the platform does for you. In the
// app there is no command to point at — the step is one button — so "this" becomes "it", and the button under
// it is free to say the verb instead of repeating the place.
const runTitle = computed(() => (desktop.value ? `Run it on this computer` : `Run this on your computer`));

/* The command's options are checkboxes, and now they look like checkboxes: the design system's own control
 * (animated in primeng.css, so this row ticks the same way every other box in the app does) with its name
 * beside it. They were chips — a bordered pill that filled in when pressed — which is a toggle BUTTON, and it
 * dressed three quiet options as the loudest thing on a card whose subject is a command. The tick is the
 * state; it needs no box around the box.
 *
 * The shared min-width is what survives from the chips, and it is the reason the group reads as a group: every
 * caption starts in the same column at any width where the names fit on their caption's line. */
const optionLabel = `shrink-0 text-content md:min-w-[11.5rem]`;

// The chosen target once its inputs are complete — what the setup code is minted for; undefined keeps it locked.
const target = computed<SetupCodeTarget | undefined>(() => {
    if (mode.value === `intentic`) {
        return { mode: `intentic` };
    }
    if (cfTokenValid.value && selectedZone.value !== undefined && subdomainValid.value) {
        return { mode: `own`, zone: selectedZone.value, subdomain: subdomain.value.trim() };
    }
    return undefined;
});
// Identity of the target, for mint dedupe + stale-response drops (a mint answers for the key it was fired for).
// The sandbox id is part of the key — a code redeems ONE sandbox's token, so switching sandboxes mid-page
// (resume → "create a new one instead") invalidates the previous mint instead of showing sandbox A's command
// for sandbox B. The sync choice is deliberately NOT part of this — it rides the command, not the code, so
// toggling it never re-mints.
// The LANE is part of the gate, not just the inputs: minting is what provisions the intentic tunnel + DNS, and
// an attached sandbox reaches the browser over the user's own domain — so a code minted while in the attach
// lane would buy Cloudflare infrastructure nothing will ever dial. Undefined here also re-arms the mint when the
// user comes back: the key changes from undefined to a real one, which is exactly what the watcher fires on.
const targetKey = computed<string | undefined>(() => {
    const chosen = target.value;
    if (chosen === undefined || created.value === null || lane.value === `attach`) {
        return undefined;
    }
    return `${created.value.id}:${chosen.mode === `intentic` ? `intentic` : `own:${chosen.zone}:${chosen.subdomain}`}`;
});

// The command can be built only once the chosen target has a code minted for it.
const commandReady = computed(() => setup.value !== null && mintedFor.value === targetKey.value);
const lockedReason = computed(() => {
    if (mode.value === `intentic`) {
        return setupError.value ?? `Preparing your intentic domain…`;
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
    return setupError.value ?? `Preparing your install command…`;
});

/* --- the handoff (step 3) ---
 *
 * Step 3 is a HANDOFF to a machine this browser cannot see, and every way people get stuck here comes from the
 * card not modelling that. It used to have exactly one state — a spinner and "waiting for your sandbox to report
 * in", shown from the moment the code was minted — so a person who had not opened a terminal and a person whose
 * Docker pull was four minutes deep saw the identical screen, forever. It read as "the platform is provisioning
 * something", which is the one thing it never means, and the only button-shaped thing left on the card was
 * "Check now". So people sat and pressed it — which is also why that button is gone: the registry is polled
 * every 3s either way, so it never bought a single second, and offering it made pressing it look like progress.
 *
 * `handoff` is that missing model, in the order it actually happens:
 *   • `locked`  — the chosen path isn't ready, so there is no command yet (lockedReason says what's missing)
 *   • `yours`   — the command is on screen and NOTHING is in flight; the next move is the user's, in a terminal
 *   • `handed`  — they copied it (or, in the app, pressed the button), so we are waiting on their machine
 *                 rather than on our own infrastructure
 *   • `claimed` — a machine redeemed the setup code at /setup/claim: the command demonstrably ran, and the
 *                 minutes of invisible Docker work that follow are finally a wait this page has earned
 *
 * The `claimed` state is the one that needed a server change (Sandbox.setupCodeClaimedAt): the claim is the only
 * evidence the platform ever gets that the pasted command reached a machine, and without it the card cannot
 * tell "you haven't run it yet" from "it's running and slow" — which is exactly the ambiguity people resolve,
 * wrongly, by waiting. */
type Handoff = "locked" | "yours" | "handed" | "claimed";

// This browser put the command on the clipboard. Page-level and persistent, unlike CopyButton's own 1.5s
// flash: it is the hinge the card turns on, not a button animation.
const copied = ref(false);
// The app was handed the setup code — the desktop path's equivalent of copying, and the last thing this page
// can observe before the machine takes over. Without it, pressing the one button on the card left the footer
// still reading "Nothing is running yet" for as long as it takes the app to claim.
const launched = ref(false);
// A link back to this screen is in the user's inbox (the phone's handoff — SetupHandoff.vue). Deliberately NOT
// part of `handoff` below: that state machine tracks the COMMAND's journey to a machine, and posting yourself a
// bookmark does not advance it by a step. What it does change is what the stuck-wait nudge should say, because
// for this user the next move is on a laptop that hasn't been opened yet rather than in a terminal.
const emailed = ref(false);
// Server-side proof the command ran somewhere: when a machine last redeemed THIS code. Minting clears the
// stamp server-side, so a value here always describes the command currently on screen.
const claimedAt = ref<string | null>(null);

// There is a command out there and we're watching the registry — drives the card's footer. Gated on
// `commandReady` rather than a bare mint, so a re-mint's stale command never narrates a wait of its own.
const waiting = computed(() => commandReady.value);
const handoff = computed<Handoff>(() => {
    if (!commandReady.value) {
        return `locked`;
    }
    if (claimedAt.value !== null) {
        return `claimed`;
    }
    return copied.value || launched.value ? `handed` : `yours`;
});

/* The card escalates on its own, because the failure it guards against is silent: someone who has not realised
 * the command has to be run somewhere else will never do anything this page can react to, so nothing but
 * elapsed time can trigger the correction. `armedAt` is when the command became runnable — reset by a re-mint,
 * which hands out a different command. */
const armedAt = ref<number | undefined>(undefined);
// The app's one wall clock, armed only while a command is on screen — nothing below reads it before then
// (waitedMs is 0 without an armedAt, and `claimed` implies one), so an unarmed step 3 costs no tick.
const now = useNow(() => armedAt.value !== undefined);
watch(commandReady, (ready) => {
    armedAt.value = ready ? Date.now() : undefined;
});

// When the card stops being polite about the likeliest reason nothing has reached us — the command is still
// sitting on a clipboard. Long enough to walk to another machine; short enough to catch someone who has
// settled in to watch this page. The compose path is a file to paste into an editor and edited there, so the
// same nudge on that tab would fire at somebody doing exactly the right thing.
// A phone gets the same long fuse, for the same reason in a different shape: the step is a walk to another
// machine BY CONSTRUCTION there, and the handoff above says so before the command is even reached — so forty
// seconds would fire at someone who has understood perfectly and is halfway to their desk.
const nudgeAfterMs = computed(() => (composeShown.value || mobile.value ? 3 * 60_000 : 40_000));
// And when it stops assuming the command was never run, and starts helping the person whose terminal errored.
const STALLED_MS = 3 * 60_000;
// A claimed code with no daemon behind it yet: the first image pull is genuinely slow, so this waits much
// longer before suggesting the terminal has something to say.
const SLOW_BUILD_MS = 6 * 60_000;

const waitedMs = computed(() => (armedAt.value === undefined ? 0 : now.value - armedAt.value));
const nudging = computed(() => handoff.value !== `claimed` && waitedMs.value > nudgeAfterMs.value);
const stalled = computed(() => handoff.value !== `claimed` && waitedMs.value > STALLED_MS);
const slowBuild = computed(
    () => claimedAt.value !== null && handoff.value === `claimed` && now.value - new Date(claimedAt.value).getTime() > SLOW_BUILD_MS,
);

// Copying is the last thing this browser can observe before the user leaves for a terminal, so it is also the
// most informative funnel milestone between "was shown a command" and "ran one".
// `mobile` rides along because the same event means opposite things on the two devices: a copy on a desktop is
// a step towards a terminal that is right there, and a copy on a phone writes to a clipboard no terminal can
// read. Without the split those two average into one meaningless conversion rate — which is why nobody could
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

// oRPC surfaces a disabled endpoint as NOT_FOUND (404) — the signal that the intentic-provided path is off.
const isNotFound = (err: unknown): boolean => {
    if (err && typeof err === `object`) {
        const e = err as { code?: unknown; status?: unknown };
        return e.code === `NOT_FOUND` || e.status === 404;
    }
    return false;
};

// The daemon registers ONCE on boot, so lastSeenAt marks its last (re)start, not a live heartbeat — we can't
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

// Why we're still waiting (undefined while nothing informative to say) — step 4 shows it so a stuck wait names
// its cause instead of spinning silently.
const status = ref<string | undefined>(undefined);
// A poll is in flight. Purely a re-entrancy guard — the 3s interval must not stack requests behind a slow
// one. It is deliberately NOT rendered: it used to drive a "Check now" button's busy state, which meant the
// automatic poll flipped that button's label and icon every third second for as long as the user sat there.
const checking = ref(false);

/* Poll the platform registry for the daemon's boot registration (POST /sandbox/announce writes daemonUrl +
 * lastSeenAt). When lastSeenAt advances past the baseline, a daemon has come up for this sandbox — open the
 * workspace. Same-origin, no DNS resolution of the sandbox hostname.
 *
 * The row is looked up by `created.id` IN THE LIST THE REFRESH RETURNED, never through `sandbox.active`. Those
 * are the same sandbox only while the selection happens to point at the one being set up, and `reconcileActive`
 * moves the selection to `live[0]` whenever the active id is absent from a list response — which is exactly
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
    // longer exists, and its claim stamp would report the PREVIOUS command as picked up — the one lie this
    // card must never tell, since the whole point of the stamp is that it is trustworthy.
    const askedFor = mintedFor.value;
    checking.value = true;
    try {
        const live = await sandbox.refresh();
        // A reachable platform clears any earlier "can't reach" warning — it must not outlive its cause.
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
        }
        const seen = row?.lastSeenAt ?? null;
        if (seen !== null && seen !== baseline.value) {
            // Onboarding's make-or-break milestone: the pasted command produced a live daemon.
            track(`sandbox_connected`, { resuming: resuming.value });
            // Point the workspace at the sandbox this page just set up. The same `reconcileActive` fallback that
            // used to trigger this redirect can also have moved the selection away while we were waiting, and
            // opening someone's older sandbox at the end of setting up a new one is the same wrong answer
            // arriving one step later.
            sandbox.select(pending.id);
            await router.push(`/`);
        }
    } catch {
        status.value = `Can't reach the platform to check — retrying…`;
    } finally {
        checking.value = false;
    }
};

// Create a new sandbox (mints its connection token) and make it active. Entry point of the flow — the mint
// watcher below takes over the moment `created` holds a sandbox.
const createSandbox = async (): Promise<void> => {
    if (name.value.trim() === `` || creating.value) {
        return;
    }
    creating.value = true;
    error.value = null;
    try {
        created.value = await sandbox.create(name.value.trim());
    } catch (err) {
        // A plan-gate hit renders the server's message inline like any other failure. It does NOT raise the
        // Upgrade dialog: a modal sell on top of a half-finished setup is the same pitch this screen just
        // stopped making, and the message already names the cap.
        error.value = errorMessage(err, `Could not create your sandbox.`);
    } finally {
        creating.value = false;
    }
};

// Connect a sandbox that is ALREADY reachable: probe the pasted address from this browser, and only once the
// daemon has authorized us record it on the platform. Verifying BEFORE creating anything means a typo can't
// leave an orphan sandbox behind (or burn the free plan's single slot); a retry after a failed attach re-uses
// the row the previous attempt created. On success there is nothing left to do — straight to the workspace.
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
            error.value = `Sign in with Google to reach your sandbox.`;
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
        // Reuses the row when there already is one — a resumed sandbox, or one a previous attempt created whose
        // attach then failed — so retrying never mints a second sandbox against the plan's quota.
        const row = created.value ?? (await sandbox.create(attachedName.value));
        created.value = row;
        await sandbox.attach(row.id, url);
        // Same milestone as the provision lane's announce — the user has a live sandbox in the workspace, and
        // the workspace has to open on THAT one (see check()).
        track(`sandbox_connected`, { resuming: resuming.value, attached: true });
        sandbox.select(row.id);
        await router.push(`/`);
    } catch (err) {
        error.value = errorMessage(err, `Could not connect your sandbox.`);
    } finally {
        attaching.value = false;
    }
};

// Flip which lane step 1 heads. Nothing is copied across because nothing is duplicated: the typed name and any
// row already created stay exactly where they were, so a switch in either direction is lossless — including
// back out of a half-finished attach, whose created row simply continues as the provision lane's sandbox.
const setLane = (next: "provision" | "attach"): void => {
    lane.value = next;
    attachOutcome.value = undefined;
    attachToken.value = ``;
    error.value = null;
};

// Mint the setup code for the chosen target (the intentic path provisions the tunnel + DNS server-side before
// returning, so the hostname it shows already exists). A NOT_FOUND on the intentic path means the feature is
// off: hide the option and fall back to own-Cloudflare. Responses for a stale target are dropped.
const mint = async (chosen: SetupCodeTarget, key: string): Promise<void> => {
    if (created.value === null) {
        return;
    }
    setupError.value = undefined;
    try {
        const minted = await apiClient.sandbox.setupCode({ sandboxId: created.value.id, target: chosen });
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
        if (chosen.mode === `intentic` && isNotFound(err)) {
            intenticAvailable.value = false;
            mode.value = `own`;
        } else if (key === targetKey.value) {
            setupError.value = errorMessage(err, `Couldn't prepare your install command — try again.`);
        }
    }
};

// The locally-built sandbox image a dev sandbox runs. Without it, connect.sh pulls the published
// sandbox:stable, whose daemon predates any unreleased routes the dev web app calls — every new daemon
// endpoint would answer 404 until the next release. connect.sh's ensure_image never pulls a registry-less
// tag: it uses the local image, or builds it from the checkout the dev command runs the script from.
const DEV_SANDBOX_IMAGE = `intentic-sandbox:dev`;

// The shared env suffix each command carries: the local-dev PLATFORM_URL override (plus the shared dev
// agent-auth volume, so sandboxes created against a localhost platform keep their AI logins across resets,
// and the locally-built sandbox image so the daemon matches the working tree), and SYNC_DIR when desktop
// sync is opted in (a folder path, not a secret — the connect script runs the sync agent only when it's set).
const platformEnv = (): string =>
    platformUrlOverride.value
        ? ` PLATFORM_URL='${platformUrlOverride.value}' INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth' SANDBOX_IMAGE='${DEV_SANDBOX_IMAGE}'`
        : ``;
const platformEnvPs = (): string =>
    platformUrlOverride.value
        ? `$env:PLATFORM_URL='${platformUrlOverride.value}'; $env:INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth'; $env:SANDBOX_IMAGE='${DEV_SANDBOX_IMAGE}'; `
        : ``;
const syncEnv = (): string => (syncEnabled.value ? ` SYNC_DIR='${syncDir.value}'` : ``);
const syncEnvPs = (): string => (syncEnabled.value ? `$env:SYNC_DIR='${syncDir.value}'; ` : ``);

/* The daemon emits CORS only for the origins WEB_ORIGIN names, and both connect scripts default it to the
 * hosted app (@intentic/constants PLATFORM_WEB_ORIGIN) because that is the one browser origin that calls a
 * daemon in the normal case. THIS PAGE IS THAT BROWSER — so a build served from anywhere else (the localhost
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

// The commands carry only the short-lived setup code (redeemed by the script at /setup/claim) — plus, on the
// own-Cloudflare path, the CF token as an env var (never stored by the platform, so it can't ride the code).
// Everything between the pipe and `sh`: the runner, then the env assignments the script reads.
const linuxPrefix = (): string => {
    const envs = `${mode.value === `own` ? ` CF_TOKEN='${cfToken.value.trim()}'` : ``}${platformEnv()}${webOriginEnv()}${syncEnv()}`;
    // Production's curl|sh install needs root ONLY to install Docker when the machine has none — which is why
    // `hasDocker` can drop it (connect.sh then stops with the remedy rather than escalating). Local dev runs
    // connect.sh BY PATH as the developer — who has docker via their group and their Node toolchain (pnpm) on
    // PATH — so `sudo` there only resets PATH to root's secure_path, which kills the in-repo `pnpm build:sandbox`
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
        // Compose has NO build step and is deployed to a host that must PULL the image — so it always
        // references the published registry image, never the local `:dev` tag connect.sh rebuilds from the
        // checkout (a local-only tag can't be pulled and won't exist on a deploy target). The rendered file
        // gets pull_policy: always, tracking the moving `:stable` release.
        image: `ghcr.io/intentic/sandbox:stable`,
        googleClientId: environment.auth.googleClientId,
        webOrigin: globalThis.location.origin,
        ...(platformUrlOverride.value ? { platformUrl: platformUrlOverride.value } : {}),
    };
});

/* Which sandbox this page is setting up. Two ways in:
 *   • an id in the URL — the gate's "Open setup", the switcher's unfinished row, requireSetup's redirect
 *   • nothing in the URL, and the account has NO working sandbox but does own an unfinished one
 *
 * The second exists because leaving mid-setup is normal — you name it, mean to paste the command on the other
 * machine, and close the tab. Coming back to a blank "Name your sandbox" is worse than useless there: it hides
 * the sandbox you already made, and on the free plan (one sandbox) the Create it offers can only 402 against
 * that very row. So an account whose only sandbox is unfinished resumes it wherever it enters from.
 *
 * Gated on there being no connected sandbox anywhere, which is what keeps the switcher's "Add sandbox" honest
 * — that button exists to make a SECOND sandbox, and it is only reachable from a shell that already has a
 * working first one.
 *
 * Owned only — a member can't mint someone else's setup code, so their id falls through to the create form.
 * The check loop acts on the ACTIVE sandbox, so select it to make the URL self-contained. */
onMounted(async () => {
    void refreshPlan(); // so atLimit is accurate even on a direct navigation to /setup
    const loaded = await sandbox.list();
    const requested = route.query[`sandbox`];
    const named = typeof requested === `string` ? loaded.find((entry) => entry.id === requested) : undefined;
    const unfinished = loaded.some((entry) => entry.lastSeenAt !== null)
        ? undefined
        : loaded.find((entry) => entry.role === `owner` && entry.lastSeenAt === null);
    const found = named ?? unfinished;
    if (found?.role !== `owner`) {
        return;
    }
    sandbox.select(found.id);
    name.value = found.name;
    created.value = found;
    resuming.value = true;
});

// Escape hatch from a resumed setup: forget the resumed sandbox and drop to a blank create form. Everything
// derived from the resumed sandbox resets too — its minted code, hostname, and token-derived subdomain must
// not leak into the sandbox created next.
const startFresh = (): void => {
    resuming.value = false;
    created.value = null;
    name.value = ``;
    error.value = null;
    setup.value = null;
    mintedFor.value = undefined;
    setupError.value = undefined;
    // The handoff belonged to the abandoned sandbox's command: a copy already made, a setup already handed to
    // the app, and a claim already recorded are all facts about a machine the next sandbox has nothing to do with.
    copied.value = false;
    launched.value = false;
    claimedAt.value = null;
    subdomain.value = ``;
    derivedPrefix.value = ``;
    // The attach lane's inputs described the sandbox being abandoned — a stale domain would otherwise be sitting
    // in the field, ready to be attached to whichever sandbox is created next.
    domain.value = ``;
    attachToken.value = ``;
    attachOutcome.value = undefined;
    void router.replace({ path: `/setup` }); // drop ?sandbox= so a reload doesn't re-resume
};

/* Delete the resumed sandbox and start over. Only offered for one that NEVER started, and only at the plan
 * cap — which together are the one situation where `startFresh` alone is a dead end: it drops to a create form
 * whose Create can only 402, because the row occupying the slot is the one being abandoned. There is nothing
 * to lose in this case by construction (no daemon ever ran, so no workspace exists), and it is the only way
 * back to a different name now that a never-started sandbox no longer opens the shell — where the switcher's
 * trash icon used to be the escape hatch. */
const discarding = ref(false);
const discard = async (): Promise<void> => {
    const abandoned = created.value;
    if (abandoned === null || discarding.value) {
        return;
    }
    discarding.value = true;
    try {
        await sandbox.remove(abandoned.id);
        startFresh();
        void refreshPlan(); // the freed slot is what makes the create form usable again
    } catch (err) {
        error.value = errorMessage(err, `Could not remove this sandbox.`);
    } finally {
        discarding.value = false;
    }
};

// Watch the registry while we sit on /setup; the moment the daemon reports in, open the workspace.
const timer = setInterval(() => void check(), 3000);
onUnmounted(() => {
    clearInterval(timer);
    clearTimeout(mintTimer);
});

// Mint the setup code whenever the chosen target is complete, debounced so subdomain/folder keystrokes don't
// each mint a code. Re-minting overwrites the previous code server-side. targetKey already carries the
// sandbox id, so a resume→create-new switch re-fires this on its own.
watch(
    targetKey,
    () => {
        clearTimeout(mintTimer);
        const chosen = target.value;
        const key = targetKey.value;
        if (chosen === undefined || key === undefined || created.value === null || mintedFor.value === key) {
            return;
        }
        mintTimer = setTimeout(() => void mint(chosen, key), 500);
    },
    { immediate: true },
);

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

// Warm the browser→sandbox Google credential as soon as the install command is ready — while the user copies and
// runs it — instead of lazily on the first daemon call after the post-connect redirect. The ID token is a
// Google-signed JWT the daemon verifies; minting it needs no daemon, so having it cached means the workspace is
// reachable the instant the daemon reports in (no connecting-gate stall). Fired once.
//
// SILENT, and it must stay that way. This fires the moment step 3 renders a command — the sandbox does not
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
        <!-- The page widens at xl to make room for a second column — see the aside below the steps. Below that
             it is the single centred column it has always been, and max-w-3xl still governs the steps
             themselves, so the command never gets narrower than it is today at any width. -->
        <div
            class="animate-fade-in mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 md:gap-4 md:px-6 md:py-8 xl:max-w-[70rem]"
        >
            <!-- Wraps rather than shrinks: the three items share one line at desktop widths, and on a phone the
                 escape hatch takes the first line on its own (`order-first w-full`) so the title keeps the full
                 width instead of collapsing to "Set up / your / workspace" beside a button pushed off-screen. -->
            <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <!-- Escape hatch for a returning user: they have a workspace that already works, so /'s
                     requireSetup guard lets them back into it. Hidden for a new user, who'd only bounce back —
                     which is what `length > 0` was for, and what it stopped doing the moment this page created
                     a row of its own: naming a sandbox made "Back to workspace" appear beside the very first
                     step, offering a finished workspace to someone who has not run anything yet. -->
                <Button
                    v-if="otherWorkspace"
                    label="Back to workspace"
                    severity="secondary"
                    :text="true"
                    class="order-first -ml-3 w-full justify-start md:order-last md:ml-auto md:w-auto md:shrink-0"
                    @click="void router.push(`/`)"
                >
                    <template #icon><Icon name="arrow-left" /></template>
                </Button>
                <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-primary-600/30 bg-linear-to-br from-primary-600/20 to-primary-600/5 shadow-md md:h-12 md:w-12"
                    aria-label="intentic platform"
                >
                    <img src="/assets/intentic-logo-sized.png" alt="intentic" class="h-5 w-5 object-contain md:h-6 md:w-6" />
                </span>
                <!-- `contents` on a phone: the h1 becomes the logo's row-mate and the subtitle a full-width row
                     of its own, so the promise gets the whole width instead of a 200px column. From md up the
                     wrapper is a normal block again and the two stack beside the logo as before. -->
                <div class="contents md:block md:min-w-0 md:flex-1">
                    <h1 class="min-w-0 flex-1 text-xl font-semibold md:text-2xl">Set up your workspace</h1>
                    <!-- The promise has to match the lane: "a few minutes" and "use intentic's domain" describe
                         work the attach lane doesn't do. -->
                    <p class="w-full text-sm text-muted">
                        <template v-if="lane === `attach`"
                            >Point intentic at the sandbox you're already running. One address, and you're in.</template
                        >
                        <template v-else
                            >A few minutes to a live sandbox — no Cloudflare account required. Use intentic's domain, or bring your own.</template
                        >
                    </p>
                </div>
            </header>

            <!-- Two columns from xl: the steps, and a docked reference panel that stops covering them. Below xl
                 this is the same single column as before and the panel folds back into step 3's (i) hint.
                 `items-start` is what lets the panel stick while the steps scroll past it. -->
            <div class="flex flex-col gap-3 md:gap-4 xl:flex-row xl:items-start xl:gap-6">
                <div class="flex min-w-0 flex-1 flex-col gap-3 md:gap-4 xl:max-w-3xl">
                    <!-- Step 1: name + create the sandbox (collapses to a summary once created), or — in the attach
                 lane — the entire setup: one address for a sandbox that is already running and reachable.
                 The attach lane drops the "1" badge: it is the whole flow, not the first of four. -->
                    <StepSection
                        :step="lane === `provision` ? 1 : undefined"
                        :icon="lane === `attach` ? `link` : undefined"
                        :done="lane === `provision` && created !== null"
                        :title="step1Title"
                    >
                        <template v-if="lane === `attach`">
                            <p class="text-xs text-muted">
                                Already running the sandbox container behind a domain of your own? Give us the address it answers on — we'll check it,
                                then open your workspace. Nothing to install, nothing to provision.
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
                                        :class="cmp.input('w-full font-mono text-base md:text-sm')"
                                        @keydown.enter="connectDomain"
                                    />
                                    <!-- `attaching` is in the disabled expression, not left to the loading prop: the
                                 theme defines no disabled tokens, so a busy button would otherwise look and
                                 feel live while a probe is in flight. -->
                                    <Button
                                        label="Connect"
                                        class="w-full justify-center md:w-auto"
                                        :loading="attaching"
                                        :disabled="attaching || normalizedDomain === undefined"
                                        @click="connectDomain"
                                    >
                                        <template #icon><Icon name="link" /></template>
                                    </Button>
                                </div>
                                <span v-if="domainProblem" class="text-xs text-warning">{{ domainProblem }}</span>
                                <span v-else-if="normalizedDomain" class="text-xs text-muted"
                                    >We'll connect to <span class="font-mono">{{ normalizedDomain }}</span
                                    >.</span
                                >
                                <span v-else class="text-xs text-muted"
                                    >The https address your sandbox already answers on — https:// is optional.</span
                                >
                            </label>

                            <!-- The SAME `name` the create form binds, so switching lanes never loses what was typed.
                         Only a switcher label here, so the domain fills the placeholder rather than blocking the
                         paste. Hidden once the row exists (resumed, or created by an earlier attempt) — that
                         sandbox is already named, and the step title says so. -->
                            <label v-if="created === null" class="ui-field">
                                <span class="ui-field-label">Name</span>
                                <input
                                    v-model="name"
                                    autocomplete="off"
                                    spellcheck="false"
                                    :placeholder="derivedName === `` ? `e.g. work, staging, my-laptop` : derivedName"
                                    :class="cmp.input('w-full font-mono text-base md:text-sm')"
                                    @keydown.enter="connectDomain"
                                />
                                <span class="text-xs text-muted">
                                    Just so you can tell it apart in the switcher<template v-if="derivedName !== ``">
                                        — defaults to <span class="font-mono">{{ derivedName }}</span></template
                                    >.
                                </span>
                            </label>

                            <!-- Each probe failure names the one thing the user can do about it. -->
                            <div v-if="attachOutcome?.kind === `unreachable`" :class="cmp.alertDanger('flex flex-col gap-1')">
                                <span>Nothing answered at that address.</span>
                                <span class="text-2xs opacity-80">
                                    Check the sandbox is running and the domain points at it. The daemon's <code>WEB_ORIGIN</code> also has to name
                                    <span class="font-mono">{{ webOrigin() ?? PLATFORM_WEB_ORIGIN }}</span> — otherwise your browser blocks the call
                                    before it's sent.
                                </span>
                            </div>
                            <div v-else-if="attachOutcome?.kind === `timeout`" :class="cmp.alertDanger('flex flex-col gap-1')">
                                <span>That address accepted the connection but never answered.</span>
                                <span class="text-2xs opacity-80">
                                    Something is listening, but it isn't replying — a sandbox still starting up, or a proxy pointed at the wrong port.
                                    Give it a moment and try again.
                                </span>
                            </div>
                            <!-- The tunnel/proxy is alive but has no sandbox behind it — overwhelmingly the case when a
                         resumed sandbox's container is gone, so name that instead of quoting a 530. -->
                            <div v-else-if="attachOutcome?.kind === `no-origin`" :class="cmp.alertDanger('flex flex-col gap-1')">
                                <span>That domain is live, but no sandbox is running behind it.</span>
                                <span class="text-2xs opacity-80">
                                    Its tunnel or reverse proxy answered {{ attachOutcome.status }} with nothing to forward to. Start the sandbox
                                    container<template v-if="created !== null"
                                        >, or get a domain from intentic and run the install command instead</template
                                    >.
                                </span>
                            </div>
                            <template v-else-if="attachOutcome?.kind === `needs-token`">
                                <div :class="cmp.alertWarning('flex flex-col gap-1')">
                                    <span>Your sandbox is up, but it wouldn't let us in yet.</span>
                                    <span class="text-2xs opacity-80"
                                        >It's waiting to be claimed with the connection token it was started with. Paste that
                                        <code>CONNECT_TOKEN</code> to claim it as yours.</span
                                    >
                                </div>
                                <label class="ui-field">
                                    <span class="ui-field-label">Connection token</span>
                                    <input
                                        v-model="attachToken"
                                        type="password"
                                        autocomplete="off"
                                        autocapitalize="off"
                                        spellcheck="false"
                                        placeholder="The CONNECT_TOKEN your sandbox runs with"
                                        :class="cmp.input('w-full font-mono text-base md:text-sm')"
                                        @keydown.enter="connectDomain"
                                    />
                                    <span class="text-xs text-muted">
                                        Used once to claim the sandbox — the daemon stops asking once you're bound, so intentic never stores it.
                                    </span>
                                </label>
                            </template>
                            <div v-else-if="attachOutcome?.kind === `denied`" :class="cmp.alertDanger('flex flex-col gap-1')">
                                <span>{{ attachOutcome.message }}</span>
                                <span class="text-2xs opacity-80">Ask its owner to invite {{ user?.email }}, then connect it again.</span>
                            </div>
                            <div v-else-if="attachOutcome?.kind === `rejected`" :class="cmp.alertDanger()">{{ attachOutcome.message }}</div>

                            <div v-if="error" :class="cmp.alertDanger()">{{ error }}</div>
                            <!-- With a row already in hand, going back CONTINUES that sandbox through steps 2-4 rather
                         than setting a new one up — the label has to say which of the two it is. -->
                            <button type="button" :class="cmp.linkButton(`text-muted underline hover:text-content`)" @click="setLane(`provision`)">
                                {{ created === null ? `← Set one up for me instead` : `← Get a domain from intentic instead` }}
                            </button>
                        </template>
                        <template v-else-if="created === null">
                            <!-- At the plan cap: say so plainly instead of offering a name form whose Create can only
                         402. No upgrade pitch — this screen's job is to get a machine connected, and someone
                         who came here to do that is the worst possible audience for a plan sell; upgrading
                         lives in the account panel, where a person goes when that is the thing they want. -->
                            <p v-if="atLimit" class="text-xs text-muted">
                                Every sandbox your plan includes is already in use, so there's none spare to set up here. Reconnect one from the
                                switcher, or remove one you've finished with.
                            </p>
                            <template v-else>
                                <p class="text-xs text-muted">
                                    Give this sandbox a name so you can tell it apart in the switcher — you can run several.
                                </p>
                                <div class="flex flex-col gap-2 md:flex-row md:items-center">
                                    <input
                                        v-model="name"
                                        autocomplete="off"
                                        spellcheck="false"
                                        placeholder="e.g. work, staging, my-laptop"
                                        :class="cmp.input('w-full font-mono text-base md:text-sm')"
                                        @keydown.enter="createSandbox"
                                    />
                                    <Button
                                        label="Create"
                                        class="w-full justify-center md:w-auto"
                                        :loading="creating"
                                        :disabled="name.trim().length === 0"
                                        @click="createSandbox"
                                    >
                                        <template #icon><Icon name="plus" /></template>
                                    </Button>
                                </div>
                                <div v-if="error" :class="cmp.alertDanger()">{{ error }}</div>
                                <!-- The one-step lane, kept to a single line: it costs the common path nothing and the
                             user who needs it is looking for exactly these words. -->
                                <button type="button" :class="cmp.linkButton()" @click="setLane(`attach`)">
                                    Already running a sandbox somewhere? Connect it by domain →
                                </button>
                            </template>
                        </template>
                        <template v-else>
                            <template v-if="resuming">
                                <!-- Two different histories, and only one of them is a reconnect. A sandbox that
                                     ran before was torn down locally; one that was named and never started is
                                     simply where the user left off — telling them a container was cleared would
                                     be describing a machine that never existed. -->
                                <p class="text-xs text-muted">
                                    <template v-if="neverStarted">
                                        You named this one but never started it — pick up where you left off<template v-if="!atLimit">
                                            , or create a new sandbox instead</template
                                        >.
                                    </template>
                                    <template v-else>
                                        This sandbox still exists on the platform — the CLI cleanup only cleared its local container. Reconnect it
                                        below to start a fresh daemon<template v-if="!atLimit">, or create a new sandbox instead</template>.
                                    </template>
                                </p>
                                <!-- At the cap there is no second sandbox to offer, so `startFresh` (which drops
                                     to a blank create form) would only lead to a 402. Removing this one is the
                                     move that actually frees the slot, and it is safe precisely here: a sandbox
                                     that never started has no workspace to lose. -->
                                <button
                                    v-if="!atLimit"
                                    type="button"
                                    :class="cmp.linkButton(`text-muted underline hover:text-content`)"
                                    @click="startFresh"
                                >
                                    Not this one? Create a new sandbox instead
                                </button>
                                <button
                                    v-else-if="neverStarted"
                                    type="button"
                                    :class="cmp.linkButton(`text-muted underline hover:text-content`)"
                                    :disabled="discarding"
                                    @click="discard"
                                >
                                    {{ discarding ? `Removing…` : `Not this one? Remove it and start over` }}
                                </button>
                            </template>
                            <!-- Offered from EVERY created state, not just a resumed one: the realisation that this
                         sandbox is already running somewhere the platform never heard from (a daemon with no
                         PLATFORM_URL) arrives just as often while staring at step 3's install command. Attaching
                         points THIS row at the domain — it never mints a second sandbox. -->
                            <button type="button" :class="cmp.linkButton()" @click="setLane(`attach`)">
                                Already reachable at a domain? Connect it →
                            </button>
                        </template>
                    </StepSection>

                    <!-- Step 2: how to reach the sandbox (intentic domain collapses to a summary; own-CF form on demand). -->
                    <StepSection v-if="created && lane === `provision`" :step="2" :done="setup !== null" title="How should we reach your sandbox?">
                        <!-- The "why a token?" hint rides the step header, the one place this page puts hints (step 3's
                     "What this does"), instead of a second heading inside the body: "Cloudflare API token"
                     above a field labelled "API token" said the same thing twice and cost a phone a whole row. -->
                        <template #actions>
                            <InfoHint v-if="mode === `own`" label="Why the Cloudflare API token is required" text="Why this token">
                                <p class="mb-1 text-sm font-semibold text-content">Why this token?</p>
                                <p class="mb-3 text-2xs leading-relaxed text-muted">
                                    intentic reaches your sandbox over a private Cloudflare tunnel — no open inbound ports.
                                </p>
                                <ul class="flex flex-col gap-2 text-2xs text-muted">
                                    <li class="flex items-start gap-2">
                                        <Icon name="bolt" class="mt-0.5 text-link" />
                                        <span>Lets the install command <span class="text-content">create the tunnel</span></span>
                                    </li>
                                    <li class="flex items-start gap-2">
                                        <Icon name="lock" class="mt-0.5 text-success" />
                                        <span
                                            ><span class="text-content">Never stored by intentic</span> — used once to list zones, then rides the
                                            command</span
                                        >
                                    </li>
                                </ul>
                            </InfoHint>
                        </template>

                        <!-- Intentic-provided: fixed, read-only domain. -->
                        <template v-if="mode === `intentic`">
                            <div v-if="setupError" :class="cmp.alertDanger('text-2xs')">
                                {{ setupError }}
                            </div>
                            <!-- One row, not a bordered box inside the card: the hostname is a fact this step reports,
                         and framing it bought a second border and 24px to say nothing. The escape hatch shares
                         the line at desktop widths and wraps under it on a phone, where the hostname fills it.
                         The link names the CLOUDFLARE ZONE, not "my own domain": step 1's attach lane is the
                         literal own-domain path, and two links reading the same would send people to the wrong
                         one. This path still provisions a tunnel and still needs the run step. -->
                            <div v-else-if="setup" class="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span class="flex min-w-0 items-start gap-2 font-mono text-sm text-content">
                                    <Icon name="lock" class="mt-0.5 shrink-0 text-success" />
                                    <span class="min-w-0 break-words">{{ setup.hostname }}</span>
                                </span>
                                <button type="button" :class="cmp.linkButton(`text-2xs`)" @click="mode = `own`">
                                    Use my own Cloudflare zone instead
                                </button>
                            </div>
                            <p v-else class="text-xs text-muted"><Icon name="spinner" spin /> Preparing your intentic domain…</p>
                        </template>

                        <!-- Own Cloudflare: token + zone + editable subdomain. -->
                        <template v-else>
                            <button v-if="intenticAvailable" type="button" :class="cmp.linkButton()" @click="mode = `intentic`">
                                ← Use intentic's domain
                            </button>
                            <CloudflareTokenField
                                :cf="cf"
                                storage-note="Used once to look up your Cloudflare zones, then it rides the command into your sandbox — intentic never stores it."
                            />

                            <!-- Editable domain: the subdomain prefix under the chosen zone. The zone suffix wraps to
                         its own line rather than stealing width from the one part that is editable — an
                         account's zone can be long, and on a phone the two together left no field to type in. -->
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
                                        :class="cmp.input('w-full font-mono text-base md:w-auto md:min-w-0 md:flex-1 md:text-sm')"
                                    />
                                    <span class="font-mono text-sm break-words text-subtle">.{{ selectedZone }}</span>
                                </div>
                                <span v-if="!subdomainValid" class="text-xs text-warning">Use letters, numbers and hyphens only.</span>
                                <span v-else class="text-xs text-success"
                                    >✓ Your sandbox will be reachable at
                                    <span class="font-mono break-words">{{ subdomain.trim() }}.{{ selectedZone }}</span
                                    >.</span
                                >
                            </label>
                        </template>
                    </StepSection>

                    <!-- Step 3: run the sandbox — and the whole reason this page loses people. A copy-paste command is
                 no more dangerous than an .msi, but it arrives without any of an installer's affordances: no
                 publisher, no preview of what will happen, no list of what it changes, no uninstaller.
                 Step 4 folded in here too: waiting for the daemon asked nothing of the user, so a card of its
                 own was chrome around one sentence — and that sentence belongs under the command that causes it.

                 EVERY VISIBLE ACTOR ON THIS CARD IS THE USER. The title used to read "Run your sandbox", which
                 names no one — people read it as something the platform was doing for them, sat through a
                 spinner that started before they had done anything, and pressed the only button on the card
                 ("Check now") until they gave up. So the title gives the instruction and names the machine, and
                 the wait at the bottom is a state machine over the handoff (see `handoff`) rather than one
                 perpetual "waiting…".

                 WHAT IS ON THE CARD IS WHAT YOU DO; WHAT IS IN THE PANEL IS WHAT IT MEANS. The card carries the
                 command, the two switches that reshape it, and one line of state — and nothing else, because a
                 step people are trying to get through is not where prose belongs. Everything that is worth
                 knowing but not worth reading right now (what gets created, what is written outside Docker, how
                 to remove all of it) moved to SetupRunDetails, which is docked in a column of its own from xl
                 and folded into the (i) below it. That is also what fixed the hint landing ON the command it
                 described, on exactly the screens with room to put it beside instead.

                 AND ON A PHONE, WHAT YOU DO IS NOT THE COMMAND. The card here is one sentence, one button and
                 one line of state: the step happens on a computer this browser is not, so the email handoff is
                 the whole of it. The command and everything that dresses it — three tabs, a code block, a copy
                 button, two checkboxes, a dev note — sat between that button and the state line, five bordered
                 surfaces deep (card → panel → button, plus the tab track and the code frame), all of it in
                 service of a clipboard the target machine cannot read. It is now one line's worth of
                 disclosure, addressed to the one reader it is true for: someone holding an SSH session. -->

                    <StepSection v-if="created && lane === `provision`" :step="3" :title="runTitle">
                        <template #actions>
                            <!-- Below xl only: from there up the same content is docked in its own column (see the
                         aside at the foot of this template), where it never lands on the command. -->
                            <InfoHint class="xl:hidden" label="What running your sandbox does" text="What this does">
                                <SetupRunDetails :sync-enabled="syncEnabled" :cleanup="cleanupCommand" />
                            </InfoHint>
                        </template>

                        <!-- The command carries the chosen path's values, so we don't reveal it until that path is ready — a
                     command missing the token/zone/subdomain or the provisioned tunnel would just fail in the sandbox. -->
                        <div
                            v-if="!commandReady"
                            class="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-4 text-xs text-muted"
                        >
                            <Icon name="lock" class="mt-0.5 shrink-0" />
                            <span>{{ lockedReason }}</span>
                        </div>
                        <template v-else>
                            <!-- Inside the desktop app the terminal is gone: one click hands this same setup code to the
                                 app, which runs the same connect script on this machine and streams what it says into
                                 its manager window. So in the app this IS the step — a line of consequence, the button
                                 that causes it, and a way out for someone who wanted a server after all.
                                 It used to be a tinted, bordered panel carrying its own "Run it on this computer"
                                 heading with a primary button inside: the step title, the panel heading and the button
                                 label all saying the same sentence, three boxes deep, inside a card that already has a
                                 border. The title above names the machine, so the button only has to name the verb —
                                 which is also the shape the app's other two handoffs use (HostRecreate, the
                                 environment card), and there is no reason onboarding should be the loud one. -->
                            <template v-if="desktop">
                                <p class="text-xs text-muted">
                                    Installs Docker if you need it, starts your sandbox and its tunnel, and opens your workspace the moment it answers
                                    — no terminal.
                                </p>
                                <Button label="Set it up now" class="self-start" @click="runHere">
                                    <template #icon><Icon name="bolt" /></template>
                                </Button>
                            </template>

                            <!-- On a phone, the step's actual next move — see SetupHandoff.vue. It goes ABOVE the
                                 command because the command is the thing it is redirecting people away from, and a
                                 correction printed underneath what it corrects is read second or not at all. It is
                                 no longer gated on the command being on screen: it is what the step IS here, and the
                                 command is the thing folded behind it. -->
                            <SetupHandoff v-if="mobile && created" :sandbox-id="created.id" :email="user?.email ?? ``" @sent="onEmailed" />

                            <!-- ONE LINE WHERE THERE USED TO BE A SECTION. Both devices that don't run the command
                                 here get the same offer, worded for the reader who takes it: a server the app can't
                                 reach, or a shell app on the phone (Termius, Blink, a tmux session someone never
                                 closed). Everything the command needs — its tabs, its options, its dev note — lives
                                 inside the disclosure, so a phone that isn't driving a server never sees any of it. -->
                            <button
                                v-if="desktop || mobile"
                                type="button"
                                :class="cmp.linkButton(`gap-2 text-muted hover:text-content hover:no-underline`)"
                                @click="showCommand = !showCommand"
                            >
                                <Icon name="terminal" class="shrink-0" />
                                <span class="min-w-0">
                                    <template v-if="showCommand">Hide the command</template>
                                    <template v-else-if="desktop">Running it on a server instead? Show the command</template>
                                    <template v-else>Have a terminal here? Show the command</template>
                                </span>
                                <Icon :name="showCommand ? `chevron-up` : `chevron-down`" class="shrink-0 text-subtle" />
                            </button>

                            <div v-if="commandVisible" class="flex flex-col gap-2">
                                <!-- One line, because the title already gave the instruction and nobody reads the second
                             sentence of a step they are trying to get through. All this adds is the bit the title
                             can't: WHICH machine — which is why it belongs to the COMMAND and not to the step, and
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
                                        <template v-else>Paste it into a terminal — this computer, or any server you have a shell on.</template>
                                    </span>
                                </p>
                                <!-- On a phone the picker takes a full row of its own: three pill tabs sharing a
                             340px line wrapped every label to two lines. The copy button leaves that row with
                             it — a chip stranded on a line of its own under the tabs, one row above the thing
                             it copies, was the loose end on this card. Beside the tabs on a desktop, under the
                             command on a phone; either way it is next to what it acts on. -->
                                <div class="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
                                    <Segmented v-model="runTab" :options="runTabOptions" :stretch="mobile" />
                                    <CopyButton v-if="!mobile && runTab !== `compose`" :text="selectedCommand" label="Copy" @copied="onCopied" />
                                </div>
                                <SetupCompose v-if="runTab === `compose` && composeArgs" :args="composeArgs" />
                                <template v-else>
                                    <!-- Clamped on a phone: the command is a thing to COPY, and wrapped in full it is
                                 nine lines of env vars between the button that copies it and the step that
                                 comes next. The dev command is the long one, but even the hosted one-liner
                                 wraps to four lines at 390px.
                                 No label. It read "Terminal", to stop a dark monospace box being taken for a
                                 documentation snippet — but the line above the block already says to paste this
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
                                 opened this disclosure came for the clipboard, so here — and only here — copying
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
                                    <!-- Local dev only: platformEnv() injects SANDBOX_IMAGE=intentic-sandbox:dev — connect.sh
                                 rebuilds it from this checkout on every run (layer-cached), so the pasted command is
                                 self-sufficient and never runs a stale image after sandbox edits. Folded shut: it is a
                                 note to whoever is developing intentic itself, not a step in setting a sandbox up. -->
                                    <details v-if="platformUrlOverride" class="text-xs text-warning">
                                        <summary class="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                                            <Icon name="box" class="shrink-0" />
                                            <span class="min-w-0">Local dev: builds from your checkout</span>
                                            <Icon name="chevron-down" class="shrink-0 text-subtle" />
                                        </summary>
                                        <p class="mt-1 pl-6 text-2xs">
                                            This command builds <code>{{ DEV_SANDBOX_IMAGE }}</code> from your checkout and runs that — every run
                                            rebuilds, so sandbox edits are always picked up (cached when unchanged; the first build takes a few
                                            minutes). For a live edit loop, keep <code>pnpm dev:sandbox</code> running.
                                        </p>
                                    </details>
                                </template>
                            </div>

                            <!-- EVERY OPTION THAT REWRITES THE COMMAND, AS ONE GROUP OF CHIPS UNDER IT. These are the
                                 one thing that does not belong in the reference panel — a checkbox whose reason is a
                                 hover (or a column) away is a checkbox nobody ticks — and each chip's pressed state
                                 is visibly answered by the command one row up.
                                 Desktop sync joined them: as a ToggleSwitch above the command it was the loudest
                                 control on a step whose subject is a command, and three lines tall for an option two
                                 of its peers state in one. It is the same kind of thing they are — something that
                                 changes what this command does — so it now reads as one, and the folder it mirrors
                                 to is the caption rather than a sentence of its own.
                                 Sync outlives the command in the APP, where it rides the desktop handoff too — so it
                                 stays on screen there with the command folded away. On a phone it does not: nothing
                                 is enrolled from here, and the machine that opens the emailed link asks again. Only
                                 the compose tab drops it outright, because that file declares its own env. -->
                            <!-- The <label> stops at the option's NAME rather than wrapping the whole row: a
                                 label toggles on any click inside it, and these captions carry a folder path
                                 and a `sudo` mention — text people select and read. Clicking a row's name still
                                 hits a 200px target; selecting its caption no longer rewrites the command. -->
                            <div v-if="!composeShown && (commandVisible || desktop)" class="flex flex-col gap-1.5 text-2xs text-muted">
                                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <label class="flex cursor-pointer items-center gap-2">
                                        <Checkbox v-model="syncEnabled" :binary="true" size="small" />
                                        <span :class="optionLabel">Also sync a local folder</span>
                                    </label>
                                    <!-- On, the folder IS the news; off, the reason is. Saying both at once was one
                                         clause of each, and the clause that mattered was never the one being read. -->
                                    <span class="min-w-0">
                                        <template v-if="syncEnabled && syncDir !== ``"
                                            >Mirrors to <code class="break-words">{{ syncDir }}</code></template
                                        >
                                        <template v-else>Edit this sandbox's files in your own editor.</template>
                                    </span>
                                </div>
                                <!-- Unix only, because `sudo` is: PowerShell has no equivalent to drop, so on Windows
                             there is no switch here and the Docker prerequisite is left to the panel, which
                             names the reboot a first Windows install may want. And only while the command is on
                             screen — it rewrites one token of a line, which is no kind of offer when the line
                             itself is folded away. -->
                                <div
                                    v-if="environment.production && commandVisible && runTab === `unix`"
                                    class="flex flex-wrap items-center gap-x-2 gap-y-1"
                                >
                                    <label class="flex cursor-pointer items-center gap-2">
                                        <Checkbox v-model="hasDocker" :binary="true" size="small" />
                                        <span :class="optionLabel">I already have Docker</span>
                                    </label>
                                    <span class="min-w-0">
                                        <template v-if="hasDocker">Runs as you, no <code>sudo</code>.</template>
                                        <template v-else><code>sudo</code> is there for one job: installing Docker if it's missing.</template>
                                    </span>
                                </div>
                            </div>

                            <!-- Read in an ordinary browser: the same handoff is one click away IF the app is
                                 already installed (the OS routes the link), and one download away if it isn't.
                                 Deliberately the quietest thing on the card — the command above is the path that
                                 works on every machine, and this is an offer, not a redirect. Compose declares its
                                 own shape and is chosen by people who want a file, so it is left alone.
                                 Never on a phone: every link here is a Windows or Linux installer, and a phone
                                 that follows one downloads a .msi it cannot open. The app is worth offering to
                                 this person — just on the machine they are about to open the emailed link on,
                                 where this same block is waiting and the download actually runs. -->
                            <div
                                v-if="!desktop && !mobile && runTab !== `compose`"
                                class="flex flex-col gap-1 border-t border-line pt-3 text-2xs text-subtle"
                            >
                                <span>
                                    Rather not use a terminal? The
                                    <button type="button" class="text-link hover:underline" @click="runHere">Intentic desktop app</button>
                                    does this in one click — and updates your sandbox with a button afterwards.
                                </span>
                                <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    Get it:
                                    <a :href="DESKTOP_DOWNLOADS.windows" class="inline-flex items-center gap-1 text-link hover:underline">
                                        Windows <Icon name="external-link" />
                                    </a>
                                    <a :href="DESKTOP_DOWNLOADS.linuxAppImage" class="inline-flex items-center gap-1 text-link hover:underline">
                                        Linux AppImage <Icon name="external-link" />
                                    </a>
                                    <a :href="DESKTOP_DOWNLOADS.linuxDeb" class="text-link hover:underline">.deb</a>
                                    <a :href="DESKTOP_DOWNLOADS.linuxRpm" class="text-link hover:underline">.rpm</a>
                                </span>
                                <!-- Local dev: these point at the local site's /desktop/ assets, so the links serve
                                     YOUR build once staged — the same story as the dev sandbox image above. -->
                                <p v-if="platformUrlOverride" class="flex items-center gap-2 text-warning">
                                    <Icon name="box" class="shrink-0" />
                                    <span
                                        >Local dev: stage installers with <code>pnpm --filter @intentic/desktop-app stage:downloads</code>, then run
                                        the site.</span
                                    >
                                </p>
                            </div>
                        </template>

                        <!-- Step 4's whole job, as the footer of the step it reports on — now saying WHICH of the two
                     waits this is. A spinner from the moment a code was minted is what made a screen where the
                     user has done nothing look identical to one where Docker is four minutes into an image
                     pull, and "your workspace opens automatically" is a promise about the second that reads, in
                     the first, as permission to sit still.
                     So the icon leads, and for the idle state it is a DOT rather than a ring: an unfilled
                     circle beside a line of status text is read as a spinner that has stopped turning, which
                     is a bug report, not a state. A small filled dot is a status light — it is not supposed to
                     move, and nobody waits for it to.
                     There is no "Check now" here any more. The registry is polled every 3s regardless, so the
                     button re-asked a question already being asked and bought nothing but its own presence —
                     and because the poll shares `checking`, it spent every third second flipping itself to
                     "Checking…" and back, which is a card that looks broken while it works perfectly. -->
                        <div v-if="waiting" class="flex flex-col gap-2 border-t border-line pt-3">
                            <p class="flex items-start gap-2 text-xs" :class="handoff === `claimed` ? `text-content` : `text-muted`">
                                <Icon v-if="handoff === `claimed`" name="spinner" spin class="mt-0.5 shrink-0 text-success" />
                                <Icon v-else-if="handoff === `handed`" name="spinner" spin class="mt-0.5 shrink-0 text-info" />
                                <Icon v-else name="circle-fill" class="mt-1 shrink-0 text-[0.5rem] text-subtle" />
                                <span class="min-w-0">
                                    <template v-if="handoff === `claimed`">
                                        <span class="font-medium text-success">Your machine picked it up.</span> Starting Docker — the first run takes
                                        a few minutes.
                                    </template>
                                    <!-- Handed off two ways, and the next move differs: a copied command still has to
                                         be pasted, while the app already has everything and is opening its own window. -->
                                    <template v-else-if="handoff === `handed` && launched">
                                        <span class="font-medium text-content">Handed to the app.</span> Follow it in the Intentic window — this page
                                        opens your workspace the moment it answers.
                                    </template>
                                    <template v-else-if="handoff === `handed`">
                                        <span class="font-medium text-content">Copied.</span> Paste it into that terminal and press Enter.
                                    </template>
                                    <template v-else>
                                        <span class="font-medium text-content">Nothing is running yet.</span> We'll notice the moment it starts.
                                    </template>
                                </span>
                            </p>

                            <!-- The correction, on a timer, because the mistake this card exists to prevent is SILENT:
                         somebody who has not understood that the command runs elsewhere never does anything the
                         page can react to, so elapsed time is the only trigger there is. -->
                            <div v-if="nudging" :class="cmp.alertWarning('flex flex-col gap-2')">
                                <p class="flex items-start gap-2">
                                    <Icon name="clock" class="mt-0.5 shrink-0" />
                                    <!-- The correction only holds where the command is the path. In the app the button
                                         IS the path, so the same sentence would send someone to a terminal the step
                                         above just told them they don't need. -->
                                    <!-- A phone that has already sent itself the link does not need to be told
                                         where the command runs — it needs the one thing it hasn't done, which is
                                         open the mail on the other machine. Telling that reader to find a
                                         terminal is the same wrong advice this screen used to give by default. -->
                                    <span v-if="mobile && emailed" class="min-w-0">
                                        <span class="font-medium">Still nothing.</span> Open the link we emailed you on the computer that will host
                                        your sandbox — the command is waiting there.
                                    </span>
                                    <span v-else-if="commandVisible" class="min-w-0">
                                        <span class="font-medium">Still nothing.</span> This has to be pasted into a terminal on the machine that will
                                        run your sandbox.
                                    </span>
                                    <!-- A phone with the command still folded away has not been told anything wrong
                                         yet — it simply hasn't taken the one step the card offers. -->
                                    <span v-else-if="mobile" class="min-w-0">
                                        <span class="font-medium">Still nothing.</span> Email yourself the link above and open it on the computer that
                                        will host your sandbox.
                                    </span>
                                    <span v-else-if="launched" class="min-w-0">
                                        <span class="font-medium">Still nothing.</span> Check the Intentic window — it shows what the setup is doing,
                                        and any error it hit.
                                    </span>
                                    <span v-else class="min-w-0">
                                        <span class="font-medium">Still nothing.</span> Nothing starts until you press "Set it up now" above.
                                    </span>
                                </p>
                                <!-- After three minutes, stop assuming it was never run and start helping the person
                             whose terminal answered back. Both readings get an action they can take. -->
                                <p v-if="stalled && commandVisible" class="pl-6 text-2xs opacity-90">
                                    Already ran it? Check that terminal — an error there stops the sandbox before it can report in. Safe to run again.
                                </p>
                                <!-- `cta`, because in this banner copying again IS the way out — the quiet chip
                                     that suits a copy-beside-content read as the dimmest thing in the loudest
                                     box on the card. self-start, or the column flex stretches it edge to edge.
                                     Except on a phone that has mailed itself the link, where copying again is
                                     not the way out of anything: the clipboard was never the blocked step. -->
                                <CopyButton
                                    v-if="commandVisible && runTab !== `compose` && !(mobile && emailed)"
                                    class="ml-6 self-start"
                                    :text="selectedCommand"
                                    label="Copy again"
                                    :cta="true"
                                    @copied="onCopied"
                                />
                            </div>

                            <!-- A claim with no daemon behind it is a genuinely different failure from silence: the
                         command ran, so the terminal is where the answer is. Much longer fuse — the first image
                         pull legitimately takes minutes. -->
                            <p v-if="slowBuild" class="flex items-start gap-2 text-2xs text-warning">
                                <Icon name="exclamation-circle" class="mt-0.5 shrink-0" />
                                <!-- Where the answer is depends on what actually ran it — the app streams its own
                                     log, everything else has a terminal. Asking `commandVisible` instead used to
                                     send a phone whose command is folded away to an app window that only exists on
                                     a desktop. -->
                                <span class="min-w-0"
                                    >Picked up a while ago, still no sandbox. Check {{ launched ? `the Intentic window` : `that terminal` }} for an
                                    error — it's safe to re-run.</span
                                >
                            </p>
                        </div>
                        <p v-if="status" class="text-2xs text-warning">{{ status }}</p>
                    </StepSection>
                </div>

                <!-- The docked half of step 3's reference material (SetupRunDetails carries the reasoning).
                     Present only while step 3 is, because it is that step's material and nothing else's — the
                     attach lane runs no command and has nothing to explain here. `hidden` below xl: the same
                     content is on step 3's (i) hint there, and the hint's trigger is `xl:hidden` in turn, so
                     exactly one of the two is reachable at any width. -->
                <aside v-if="created && lane === `provision`" class="hidden xl:sticky xl:top-8 xl:block xl:w-72 xl:shrink-0">
                    <div class="rounded-2xl border border-line bg-card p-4">
                        <SetupRunDetails :sync-enabled="syncEnabled" :cleanup="cleanupCommand" />
                    </div>
                </aside>
            </div>
        </div>
    </div>
</template>
