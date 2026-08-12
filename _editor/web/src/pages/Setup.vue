<script setup lang="ts">
import type { HostedOffer, SandboxSummary, SetupCode, SetupCodeTarget, SetupReport } from "@intentic-app/api-contract";
import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { sandboxSubdomain, syncFolder } from "@intentic/sandbox-contract";
import {
    cmp,
    Code,
    commandLang,
    CopyButton,
    InfoHint,
    Notice,
    type NoticeModel,
    Segmented,
    StepSection,
    useDevice,
    useOsPreference,
} from "@intentic/ui";
import { noticeFrom, noticeOf, useNow } from "@intentic/ui/async";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { track } from "../composables/analytics";
import { apiClient } from "../composables/useApi";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import CloudflareTokenField from "../components/CloudflareTokenField.vue";
import { useCloudflareZones } from "../composables/extensions/useCloudflareZones";
import { sandboxIdFromToken } from "../composables/sandbox/sandboxIdFromToken";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { DESKTOP_DOWNLOADS, desktopSetupLink, desktopVersion, openDesktopLink } from "../environments/desktop";
import { environment } from "../environments/environment";
import { bashCommand, psCommand, scriptSource } from "../environments/scriptCommand";
import SetupCloud from "./SetupCloud.vue";
import SetupCompose from "./SetupCompose.vue";
import SetupHandoff from "./SetupHandoff.vue";
import SetupRunDetails from "./SetupRunDetails.vue";
import { cloudProviderMeta } from "./setupCloud";
import type { ComposeArgs } from "./setupCompose";
import { type AttachOutcome, daemonUrlProblem, normalizeDaemonUrl, probeDaemon } from "./setupAttach";
import { autoSandboxName } from "./setupName";
import { setupReportView } from "./setupReport";

/* The setup gate's destination (outside the workspace shell). THERE ARE TWO STEPS, and the first asks for
 * NOTHING: the sandbox is created on arrival under a name this page picks (autoCreate + setupName.ts) and its
 * address is provisioned right behind it, so step 1 opens already done and reports two facts — the name, with a
 * pencil, and the address — one line each. They were two cards until they were two one-liners between them:
 * a numbered card whose whole body was a rename link, above a numbered card whose whole body was a hostname,
 * is a spine that counts to three to say the machine is ready to be started.
 *
 * The address line is where the two reachability paths part:
 *   • intentic-provided (default): the platform provisions a Cloudflare tunnel under its OWN zone; the user needs no
 *     Cloudflare of their own. The subdomain is fixed (server-derived from the connection token), so this path IS
 *     the one-liner and the escape hatch shares its row.
 *   • own Cloudflare: the user pastes their token, picks a zone, and edits the subdomain; the sandbox creates its own
 *     tunnel. The token only reaches the platform for a request-scoped zone listing, then is dropped — on this path it
 *     rides the command as a CF_TOKEN env var, never stored. That is a form, and it expands the step in place.
 * Either way the platform mints a SHORT-LIVED SETUP CODE (sandbox.setupCode) for the chosen target; the copy-paste
 * command carries only that code and the connect script redeems it at POST /setup/claim for the real values — so no
 * raw token lands in shell history. Step 2 also offers desktop sync (on by default): the choice + folder ride the
 * same code (SYNC_DIR + a platform-minted single-use SYNC_PAIR_TOKEN in the payload), so the one pasted command
 * additionally enrolls the sync agent after the sandbox boots — no second paste. Step 2 also carries the CLOUD
 * MACHINE choice (`machine` below, SetupCloud.vue): no computer to paste into, so one is created in the user's
 * own cloud account and its first boot claims this same code headlessly. Once running, the DAEMON announces
 * its URL + liveness to the platform; this page just polls sandbox.list for a fresh lastSeenAt and then opens the
 * workspace — the browser never resolves the sandbox hostname here, so no DNS race can wedge setup. That wait is
 * step 2's own footer rather than a step of its own: it asks the user for nothing, so a card of its own was chrome
 * around one sentence, and the sentence belongs under the command whose result it is reporting.
 *
 * Step 2 is also where the flow is most often abandoned — not because a pasted command does more than an .msi
 * would, but because it shows up without any of an installer's affordances. So the card states what will be
 * created, what it writes outside Docker and how to remove all of it, and offers the one switch that reshapes
 * the command instead of leaving the reader to abandon it: `hasDocker` (drop the `sudo`, which is only ever there
 * to install Docker).
 *
 * That is the PROVISION lane. There is a second, one-step ATTACH lane for a user whose sandbox is already running
 * behind a domain of their own: they paste the address, the browser probes it (setupAttach.ts), and sandbox.attach
 * records it — no tunnel to provision, no command to run, no announce to wait for, so step 2 never renders.
 * `lane` decides which spine step 1 is the head of.
 *
 * The two lanes SHARE their state rather than mirroring it. Everything a lane owns is genuinely lane-specific
 * (the reachability target, the command, the sync opt-in vs. the domain and the probe outcome); everything about
 * the sandbox itself — its `name` and its `created` row — is one value read by both. That is what makes a lane
 * switch lossless in either direction at any point: a name typed before switching survives, and a row created by
 * an attach whose probe passed but whose attach then failed continues as the provision lane's sandbox instead of
 * being stranded. The attach lane shows that name as a field and the provision lane behind a pencil, but
 * both edit the same buffer and commit it the same way (saveName). `targetKey` is gated on the lane for the same reason in reverse — minting is what buys the
 * Cloudflare tunnel, and an attached sandbox is reached over the user's own domain, so it must not mint. */

const sandbox = useSandbox();
const router = useRouter();
const route = useRoute();
// A phone gets a DIFFERENT step 2, not a narrower one — the command runs on a machine this browser is not, so
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
// The name on screen: the created row's, until the user edits it in the rename box (or the attach lane's field).
const name = ref(``);
const creating = ref(false);
const error = ref<NoticeModel | null>(null);

// The rename box, open only when asked for. The name is a default nobody typed, so changing it has to be one
// click away — and it must never be a gate: setup runs to completion whether or not this is ever touched.
const renaming = ref(false);
const savingName = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);

// Is there a workspace to go BACK to — some sandbox other than the one being set up here that has actually
// reported in. Both halves matter: a row this page created moments ago is not somewhere to return to, and
// neither is one that has never had a daemon (its shell would open on a connecting gate that never resolves).
const otherWorkspace = computed(() => sandbox.sandboxes.value.some((entry) => entry.id !== created.value?.id && entry.lastSeenAt !== null));

// The reachability mode (step 1's address line). Default is the zero-config intentic-provided path; "own" is the bring-your-own-Cloudflare toggle.
const mode = ref<"intentic" | "own">(`intentic`);
// Whether the intentic-provided path is offered at all (false once its mint 404s — the server feature flag).
const intenticAvailable = ref(true);

// --- setup code state (both paths) ---
// The minted {code, hostname, expiresAt} for the currently chosen target; the command carries only the code.
const setup = ref<SetupCode | null>(null);
const setupError = ref<NoticeModel | undefined>(undefined);
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

// --- desktop sync opt-in (step 2) ---
// On by default: the same pasted command also enrolls the sync agent. The folder rides the command as a
// SYNC_DIR env var (a path, not a secret), so toggling this just adds/removes it — no re-mint. The folder is
// derived from the sandbox name AND the hostname the mint just provisioned (not user-editable) — shown as
// info, not a field — so it carries the same id the sandbox's address does. Empty until the mint lands, which
// is also when the command that would carry it appears.
const syncEnabled = ref(true);
const syncDir = computed(() => (created.value && setup.value ? syncFolder(created.value.name, setup.value.hostname) : ``));

// --- attach lane (step 1's one-step alternative) ---
// Which spine step 1 heads: `provision` (name + address, then run and wait in step 2) or `attach` (paste the domain
// the sandbox is ALREADY reachable at → verify → workspace), which finishes inside step 1 itself.
//
// Both lanes work on the SAME `name` and the SAME `created` row — a sandbox's name and identity are facts about
// the sandbox, not about how the user chose to reach it. Duplicating either into lane-local state is what makes
// a lane switch lose typing, so there is deliberately no `attachName`/`attachRow` here.
const lane = ref<"provision" | "attach">(`provision`);
/* The one "reach it some other way" disclosure, open. Both ways off the default address — your own Cloudflare
 * zone, and a domain the sandbox already answers on — used to be their own link in their own place, and
 * telling them apart needed the distinction they exist to explain. One link, two choices under it, each
 * described by what the reader already knows about their own machine. */
const reaching = ref(false);
const domain = ref(``);
// The connection token the daemon was started with, revealed only after a `needs-token` probe. Used for that
// one first-bind request and never persisted — the daemon stops caring the moment an owner is bound, so the
// platform has no reason to hold a copy (same posture as the Cloudflare token above).
const attachToken = ref(``);
const attaching = ref(false);
const attachOutcome = ref<AttachOutcome | undefined>(undefined);

const normalizedDomain = computed(() => normalizeDaemonUrl(domain.value));
const domainProblem = computed(() => daemonUrlProblem(domain.value));

// A resumed sandbox that has ACTUALLY run before is being reconnected; one that was named and never started is
// just being picked back up, and calling that "Reconnect" claims a history it doesn't have. Read by the
// resumed sandbox's own line, which is the only place on the card that says which of the two this is — the
// provision card carries no title to put it in.
const neverStarted = computed(() => created.value !== null && created.value.lastSeenAt === null);

// Step 2 shows one command at a time; the preferred OS is a persisted singleton shared across screens.
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
        title: `No script runs: read the whole file, then start it yourself`,
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

/* THE THIRD WAY TO RUN STEP 3 — the desktop app (_editor/desktop-app), when this page is being read INSIDE it.
 *
 * It is the same handoff the command is: the app claims this same setup code and runs the same connect
 * script, so nothing about steps 1-2 or the announce-watch below changes. What it removes is the terminal —
 * which is what people actually balk at here, and what the two switches above can only soften.
 *
 * So inside the app step 2 IS that button, not a second offer beside a command: one line of consequence, the
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
/* WHICH MACHINE runs step 2 — the computer the user already has (the command / handoff / app button), or a
 * new one created in THEIR cloud account (SetupCloud.vue). A phone defaults to `cloud` because it is the
 * first path a phone can actually finish alone: the email handoff asks for a second computer, this asks for a
 * credential paste. The picker is hidden inside the desktop app (the app IS a computer the user has — its one
 * button is the step there), so `machine` stays `mine` in it by construction.
 *
 * The cloud machine claims the SAME minted setup code the command would, so everything downstream — the
 * locked gate, the claim stamp, the stage report, the announce watch — is untouched; only the card's content
 * and the wait's wording switch on this. It needs the intentic-provided tunnel (the machine boots headless,
 * with no Cloudflare of its own), so the form yields to a pointer at step 1 while `mode` says `own`. */
const machine = ref<"hosted" | "mine" | "cloud">(mobile.value ? `cloud` : `mine`);
const cloudOffered = computed(() => intenticAvailable.value && !desktop.value);

/* --- the hosted lane (machine === `hosted`) ---
 *
 * The lane with no command, no code and no machine of the user's: the platform creates the sandbox AND its
 * machine in one call (sandbox.hostedCreate), and the ordinary announce watch below carries the rest — the
 * page redirects the moment the daemon reports in, exactly as it does for a pasted run. On a platform that
 * hosts, a fresh account's FIRST run takes this lane automatically (see onMounted): sign in, watch it come
 * up, land in the workspace — zero commands, zero choices, with the other rungs one click away. */
// The platform's offer, read on arrival. Null until answered; a platform without the route reads as disabled.
const hostedOffer = ref<HostedOffer | null>(null);
const hostedOffered = computed(() => hostedOffer.value?.enabled === true && !desktop.value);
// The created row IS a hosted one — the wait card renders off this rather than off the picker, so a resumed
// hosted sandbox narrates correctly however the page was entered.
const hostedRow = computed(() => created.value?.hosted ?? null);
// The daemon's announced host, once it exists — step 1's address line for a lane that never mints a code.
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
// When the hosted wait began — the command lane's fuses are guesses about a clipboard, this is just a boot
// that should take well under a minute, so one honest "longer than usual" line is all the escalation it needs.
const hostedSince = ref<number | undefined>(undefined);
// The provisioned machine's display facts (SandboxCloudSchema) — set by the provision response (or a resumed
// row that was provisioned last visit), and the switch that turns the cloud form into its summary line.
const cloudMachine = ref<SandboxSummary[`cloud`]>(null);
const cloudProviderLabel = computed(() => (cloudMachine.value === null ? `` : cloudProviderMeta(cloudMachine.value.provider).label));
// The provision response is a fresher row (it carries the cloud stamp) — adopt it, then let the ordinary
// claim → report → announce watch narrate the machine's first boot.
const onProvisioned = (summary: SandboxSummary): void => {
    created.value = summary;
    cloudMachine.value = summary.cloud;
};

// The step names the machine, because "run this" alone reads as something the platform does for you. In the
// app there is no command to point at — the step is one button — so "this" becomes "it", and the button under
// it is free to say the verb instead of repeating the place. The cloud choice changes the machine itself, so
// the title follows it: there, nothing is run BY the user at all.
const runTitle = computed(() => {
    if (machine.value === `hosted`) {
        return `We run it for you`;
    }
    if (machine.value === `cloud` && cloudOffered.value) {
        return `Create a machine for it in your cloud`;
    }
    return desktop.value ? `Run it on this computer` : `Run this on your computer`;
});

/* THE LADDER — the machine choice as a range of power rather than a binary, each rung captioned by what it
 * costs and what it buys.
 *
 * IT IS A PICKER AND ONE CAPTION, and it has to stay that. The shape this replaced tried to say the same
 * thing with surfaces: a tinted panel for the hosted offer, a bordered list of the other two under it, the
 * chosen one ringed inside that list, and the command's own tab track and code frame under THAT — six framed
 * surfaces deep before a single instruction. Nesting is what a reader pays for structure, and a
 * three-item structure does not need paying for. Weight belongs in the words (the rung order, the caption)
 * and in what is on screen at all, never in another box around it.
 *
 * The rungs are the lanes that already exist; this picker is just the honest map: instant-and-small (hosted)
 * → a free 12 GB cloud machine or a paid one (SetupCloud's providers, Oracle's Always-Free first) → the
 * reader's own hardware (the most power, and the only GPU story anyone can offer). */
const ladderShown = computed(() => !desktop.value && (hostedOffered.value || cloudOffered.value));
const ladderOptions = computed(() => [
    ...(hostedOffered.value ? [{ label: mobile.value ? `Instant` : `Instant, we host it`, value: `hosted` as const }] : []),
    { label: `A computer I have`, value: `mine` as const },
    ...(cloudOffered.value ? [{ label: `A new cloud machine`, value: `cloud` as const }] : []),
]);
const machineCaption = computed(() => {
    if (machine.value === `hosted`) {
        return `Free and instant: a small private machine we run for you. It sleeps while you're away and wakes when you come back.`;
    }
    if (machine.value === `mine`) {
        return `The most power: your CPUs, your RAM, your GPU. One pasted command; needs Docker.`;
    }
    return `A fresh machine in your own cloud account, including Oracle's Always-Free tier (12 GB RAM, $0/month).`;
});

/* The command's options are checkboxes, and now they look like checkboxes: the design system's own control
 * (animated in primeng.css, so this row ticks the same way every other box in the app does) with its name
 * beside it. They were chips — a bordered pill that filled in when pressed — which is a toggle BUTTON, and it
 * dressed three quiet options as the loudest thing on a card whose subject is a command. The tick is the
 * state; it needs no box around the box.
 *
 * The shared min-width is what survives from the chips, and it is the reason the group reads as a group: every
 * caption starts in the same column at any width where the names fit on their caption's line. */
const optionLabel = `shrink-0 text-content md:min-w-[11.5rem]`;

/* The label column of step 1's two facts. A fixed width is what makes "Name" and "Address" one grid rather
 * than two sentences that happen to be stacked — and the width is the reason the VALUES line up, which is the
 * only alignment on the card that carries meaning. Muted and small against a mono value in content colour:
 * the name used to sit in the step's own heading, in the heading's weight and the heading's colour, where the
 * one word on the card worth changing read as the label in front of it. */
const factLabel = `w-16 shrink-0 text-xs text-muted`;

/* …and the slot each value sits in. It looks like an empty box because it IS one: the name has to be able to
 * turn into a text field without moving, which means the idle name already wears the field's height, padding
 * and (transparent) border. The address wears the same slot for one reason — otherwise the field's padding
 * would start the name a few pixels right of an address that has none, and the two facts on this card would
 * be out of line down the only column that carries meaning. Paying that back with a negative margin was the
 * first attempt and it hard-codes a spacing token the theme is free to change. */
const factSlot = `flex min-h-8 min-w-0 items-center rounded-md border border-transparent px-2 font-mono text-sm text-content`;

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
    // The hosted lane never mints: its machine was born holding the tunnel, and a code would buy a command
    // nothing will ever run — same reasoning as the attach lane's gate.
    if (chosen === undefined || created.value === null || lane.value === `attach` || machine.value === `hosted` || hostedRow.value !== null) {
        return undefined;
    }
    return `${created.value.id}:${chosen.mode === `intentic` ? `intentic` : `own:${chosen.zone}:${chosen.subdomain}`}`;
});

// The command can be built only once the chosen target has a code minted for it.
const commandReady = computed(() => setup.value !== null && mintedFor.value === targetKey.value);
// `.title` rather than the NoticeModel itself — interpolated whole, it renders as its own JSON.
const lockedReason = computed(() => {
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
/* The machine's own account of the run (SetupReport): the connect flow posts each stage while it works, and
 * on failure every broken check with its fix. This is the answer to the one question the old card could not
 * answer — a machine that claimed the code and then died left the browser guessing by elapsed time, with the
 * real reason scrolling away in a terminal that may already be closed. Cleared server-side on every mint,
 * like the claim stamp, so a value here always narrates the command currently on screen. */
const report = ref<SetupReport | null>(null);
// Diagnosis or narration, decided in setupReport.ts: `failures` is the card's verbatim what-broke list,
// `stage` the healthy run's live footer line.
const reportFailures = computed(() => setupReportView(report.value).failures);
const buildStage = computed(() => setupReportView(report.value).stage);

// There is a command out there and we're watching the registry — drives the card's footer. Gated on
// `commandReady` rather than a bare mint, so a re-mint's stale command never narrates a wait of its own.
const waiting = computed(() => commandReady.value);
const handoff = computed<Handoff>(() => {
    if (!commandReady.value) {
        return `locked`;
    }
    // A setup report is the same proof as the claim stamp — it can only come from a machine that ran the
    // command — and it can arrive FIRST: the preflight reports "Docker is not running" before anything is
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
 * elapsed time can trigger the correction. `armedAt` is when the command became runnable — reset by a re-mint,
 * which hands out a different command. */
const armedAt = ref<number | undefined>(undefined);
// The app's one wall clock, armed only while a command is on screen — nothing below reads it before then
// (waitedMs is 0 without an armedAt, and `claimed` implies one), so an unarmed step 2 costs no tick.
const now = useNow(() => armedAt.value !== undefined || hostedSince.value !== undefined);
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
// A cloud machine's fuse is the longest: its first boot legitimately spends minutes on cloud-init + a Docker
// install + the image pull before anything can claim, and a nudge inside that window would accuse a machine
// that is doing exactly what it should.
const nudgeAfterMs = computed(() => (cloudMachine.value !== null ? 6 * 60_000 : composeShown.value || mobile.value ? 3 * 60_000 : 40_000));
// And when it stops assuming the command was never run, and starts helping the person whose terminal errored.
const STALLED_MS = 3 * 60_000;
// A claimed code with no daemon behind it yet: the first image pull is genuinely slow, so this waits much
// longer before suggesting the terminal has something to say.
const SLOW_BUILD_MS = 6 * 60_000;

const waitedMs = computed(() => (armedAt.value === undefined ? 0 : now.value - armedAt.value));
// Every fuse below is a GUESS from elapsed time, and a machine report makes guessing obsolete: a failure
// card names the real problem (nudging beside it would say "you haven't run it" about a command that
// demonstrably ran and died), and live stage narration IS the answer slowBuild's "check that terminal" was
// groping for. The fuses stay for machines running an ic too old to report.
const nudging = computed(() => handoff.value !== `claimed` && waitedMs.value > nudgeAfterMs.value);
const stalled = computed(() => handoff.value !== `claimed` && waitedMs.value > STALLED_MS);
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

// Why we're still waiting (undefined while nothing informative to say) — the run step shows it so a stuck wait names
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
            const reported = row?.setupReport ?? null;
            if (reported !== null && reported.failed.length > 0 && reportFailures.value === null) {
                // The counterpart of `sandbox_connected` that never existed: setup failed WITH a named cause.
                // Every one of these used to be an invisible drop-off between claim and connect.
                track(`sandbox_setup_failed`, { stage: reported.stage, checks: reported.failed.map((failure) => failure.check).join(`,`) });
            }
            report.value = reported;
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
        status.value = `Can't reach the platform to check. Retrying…`;
    } finally {
        checking.value = false;
    }
};

/* Create the sandbox (which mints its connection token) and make it active. Entry point of the flow — the mint
 * watcher below takes over the moment `created` holds a sandbox — and it runs WITHOUT BEING ASKED FOR, on
 * arrival, which is the point.
 *
 * Step 1 used to be a form: an empty field, and a Create button that stayed dead until a word was typed. That
 * word buys nothing at this moment — a name only ever tells sandboxes apart in the switcher, and the first one
 * has nothing to be told apart from — while it costs the two things onboarding can least afford: a decision
 * before anything has been seen, and the seconds of tunnel provisioning that cannot start until a row exists.
 * Naming it here starts the address mint immediately, so the first screen a new account sees is the command.
 *
 * The name is still the user's (setupName.ts picks it, the summary renames it), it is simply no longer a gate.
 */
const autoCreate = async (): Promise<void> => {
    if (creating.value) {
        return;
    }
    creating.value = true;
    error.value = null;
    try {
        // A name already in the box wins — the attach lane offers one before any row exists, and this is also
        // the retry after a failed create, where re-picking the default would throw that typing away.
        const typed = name.value.trim();
        const row = await sandbox.create(typed === `` ? autoSandboxName(sandbox.sandboxes.value.map((entry) => entry.name)) : typed);
        created.value = row;
        name.value = row.name;
    } catch (err) {
        error.value = noticeFrom(err, `Could not create your sandbox.`);
    } finally {
        creating.value = false;
    }
};

// One honest escalation for the hosted wait: a machine boot should take well under a minute, so after two it
// is worth saying so — while the platform keeps trying either way (the machine retries, the poll keeps polling).
const hostedSlow = computed(() => hostedSince.value !== undefined && now.value - hostedSince.value > 2 * 60_000);

/* The hosted lane's create: row + machine in one platform call, then the ordinary announce watch takes over.
 * A refusal here (capacity weather, the allowance already spent) must not strand a first run staring at an
 * error — the page falls back to the classic command lane with the reason on the card, which is exactly what
 * every account saw before this lane existed. */
const hostedAutoCreate = async (): Promise<void> => {
    if (creating.value) {
        return;
    }
    creating.value = true;
    error.value = null;
    machine.value = `hosted`;
    try {
        const typed = name.value.trim();
        const row = await sandbox.hostedCreate(typed === `` ? autoSandboxName(sandbox.sandboxes.value.map((entry) => entry.name)) : typed);
        created.value = row;
        name.value = row.name;
        hostedSince.value = Date.now();
        // The zero-command milestone `sandbox_connected` will complete: a hosted machine now exists for this account.
        track(`sandbox_hosted_created`, {});
    } catch (err) {
        machine.value = mobile.value ? `cloud` : `mine`;
        error.value = noticeFrom(err, `Couldn't create a hosted sandbox. Set one up on a machine instead.`);
        creating.value = false;
        await autoCreate();
        return;
    }
    creating.value = false;
};

/* The ladder's switch. Crossing INTO or OUT OF the hosted rung swaps the sandbox itself, not just a card:
 * hosted rows are born with their machine (hostedCreate creates both), so the never-connected row the switch
 * leaves behind is deleted — seconds old, empty, and for the hosted one a machine that would otherwise sit
 * billing for a box the user just declined — and the right kind is created in its place. Only the picker
 * calls this; programmatic `machine` writes (mount, fallback) never swap. */
const setMachine = async (next: "hosted" | "mine" | "cloud"): Promise<void> => {
    const prev = machine.value;
    if (next === prev || creating.value) {
        return;
    }
    machine.value = next;
    const row = created.value;
    const rowHosted = (row?.hosted ?? null) !== null;
    const crossesHosted = next === `hosted` ? !rowHosted : prev === `hosted` && rowHosted;
    if (!crossesHosted) {
        return;
    }
    created.value = null;
    hostedSince.value = undefined;
    resuming.value = false;
    name.value = ``;
    setup.value = null;
    mintedFor.value = undefined;
    setupError.value = undefined;
    copied.value = false;
    launched.value = false;
    claimedAt.value = null;
    report.value = null;
    if (row !== null && row.lastSeenAt === null && row.role === `owner`) {
        try {
            await sandbox.remove(row.id);
        } catch {
            // A stray never-started row resumes on the next visit; nothing here is worth blocking the switch on.
        }
    }
    await (next === `hosted` ? hostedAutoCreate() : autoCreate());
};

// Open the rename box on the row's own name, selected — the name was chosen for the user, so the likeliest
// next keystroke is a replacement rather than an edit.
const startRename = async (): Promise<void> => {
    name.value = created.value?.name ?? ``;
    error.value = null;
    renaming.value = true;
    await nextTick();
    nameInput.value?.select();
};

// Commit the rename box (and the attach lane's Name field, which is the same edit under a different roof).
// Writing the row back is what keeps everything derived from the name honest — the step title, and the sync
// folder the install command carries.
const saveName = async (): Promise<void> => {
    const row = created.value;
    const trimmed = name.value.trim();
    if (row === null || savingName.value || trimmed === `` || trimmed === row.name) {
        renaming.value = false;
        return;
    }
    savingName.value = true;
    error.value = null;
    try {
        created.value = await sandbox.update(row.id, { name: trimmed });
        renaming.value = false;
    } catch (err) {
        error.value = noticeFrom(err, `Could not rename your sandbox.`);
    } finally {
        savingName.value = false;
    }
};

// Leaving the rename box puts the row's own name back in it, so an abandoned edit doesn't sit there looking saved.
const cancelRename = (): void => {
    name.value = created.value?.name ?? ``;
    renaming.value = false;
    error.value = null;
};

// Connect a sandbox that is ALREADY reachable: probe the pasted address from this browser, and only once the
// daemon has authorized us record it on the platform. Verifying BEFORE creating anything means a typo can't
// leave an orphan sandbox behind; a retry after a failed attach re-uses
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
        // There is normally a row already — one is created on arrival — and reusing it is what keeps a retry
        // after a failed attach from leaving a stray sandbox behind. The create here covers the one case where
        // there isn't: a lane switch made while the arrival create was failing.
        if (created.value === null) {
            await autoCreate();
        }
        const row = created.value;
        if (row === null) {
            return;
        }
        // The Name field is the same edit the summary's rename box makes, so it is committed on the way through
        // rather than left in a box the user is one line away from navigating out of.
        await saveName();
        await sandbox.attach(row.id, url);
        // Same milestone as the provision lane's announce — the user has a live sandbox in the workspace, and
        // the workspace has to open on THAT one (see check()).
        track(`sandbox_connected`, { resuming: resuming.value, attached: true });
        sandbox.select(row.id);
        await router.push(`/`);
    } catch (err) {
        error.value = noticeFrom(err, `Could not connect your sandbox.`);
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
            setupError.value = noticeFrom(err, `Couldn't prepare your install command. Try again.`);
        }
    }
};

// The locally-built sandbox image a dev sandbox runs. Without it, connect.sh pulls the published
// sandbox:stable, whose daemon predates any unreleased routes the dev web app calls — every new daemon
// endpoint would answer 404 until the next release. connect.sh's ensure_image never pulls a registry-less
// tag: it uses the local image, or builds it from the checkout the dev command runs the script from.
const DEV_SANDBOX_IMAGE = `intentic-sandbox:dev`;

/* …AND ONLY WHEN THE COMMAND STILL RUNS FROM THAT CHECKOUT. `intentic-sandbox:dev` carries no registry, so
 * nothing can ever pull it: connect.sh builds it, and it can only build it when invoked BY PATH, which is the
 * one form that has a repo to build from. Asking for the released script (scriptSource, the switch the
 * connect-a-computer and connect-a-server blocks carry) and still naming the dev tag would hand out a command
 * that silently runs whatever stale `:dev` image happens to be lying around — or dies on a tag it cannot
 * fetch. So the tag rides the checkout form and nothing else; the rest of the dev env is a URL and a volume
 * name, and travels either way. */
const buildsFromCheckout = computed(() => platformUrlOverride.value !== undefined && scriptSource.value === `checkout`);

// The shared env suffix each command carries: the local-dev PLATFORM_URL override (plus the shared dev
// agent-auth volume, so sandboxes created against a localhost platform keep their AI logins across resets,
// and the locally-built sandbox image so the daemon matches the working tree), and SYNC_DIR when desktop
// sync is opted in (a folder path, not a secret — the connect script runs the sync agent only when it's set).
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

/* Which sandbox this page is setting up. Three ways in:
 *   • an id in the URL — the gate's "Open setup", the switcher's unfinished row, requireSetup's redirect
 *   • nothing in the URL, and the account has NO working sandbox but does own an unfinished one
 *   • none of the above — a fresh account, or the switcher's "Add sandbox" — and one is created on the spot
 *
 * The second exists because leaving mid-setup is normal — you get as far as the command, mean to paste it on
 * the other machine, and close the tab. Coming back to a blank first step is worse than useless there: it hides
 * the sandbox you already made. So an account whose only sandbox is unfinished resumes it wherever it enters from.
 *
 * Gated on there being no connected sandbox anywhere, which is what keeps the switcher's "Add sandbox" honest
 * — that button exists to make a SECOND sandbox, and it is only reachable from a shell that already has a
 * working first one.
 *
 * Owned only — a member can't mint someone else's setup code, so their id gets them a sandbox of their own
 * instead. The check loop acts on the ACTIVE sandbox, so select it to make the URL self-contained. */
onMounted(async () => {
    const [loaded, offer] = await Promise.all([
        sandbox.list(),
        // An older platform without the route reads as "doesn't host" — the classic lanes carry on unchanged.
        // Resolve-then-call so even a client missing the method entirely lands in the catch, not in mount.
        Promise.resolve()
            .then(() => apiClient.sandbox.hostedOffer())
            .catch((): HostedOffer => ({ enabled: false, remaining: 0 })),
    ]);
    hostedOffer.value = offer;
    const requested = route.query[`sandbox`];
    const named = typeof requested === `string` ? loaded.find((entry) => entry.id === requested) : undefined;
    const unfinished = loaded.some((entry) => entry.lastSeenAt !== null)
        ? undefined
        : loaded.find((entry) => entry.role === `owner` && entry.lastSeenAt === null);
    const found = named ?? unfinished;
    if (found?.role !== `owner`) {
        // THE ZERO-CLICK FIRST RUN: on a platform that hosts, the first sandbox is created and started with
        // no command and no choice — the wait card below narrates it, and the ladder stays one click away.
        if (offer.enabled && offer.remaining > 0 && !desktop.value) {
            await hostedAutoCreate();
        } else {
            await autoCreate();
        }
        return;
    }
    sandbox.select(found.id);
    name.value = found.name;
    created.value = found;
    resuming.value = true;
    // A resumed sandbox that was provisioned last visit continues as the story it is — hosted machines may
    // still be booting (or asleep — the wake reflex handles that), and cloud machines hold a code the command
    // lane must not re-ask for.
    if ((found.hosted ?? null) !== null) {
        machine.value = `hosted`;
        hostedSince.value = Date.now();
    } else if (found.cloud !== null) {
        machine.value = `cloud`;
        cloudMachine.value = found.cloud;
    }
});

// Escape hatch from a resumed setup: forget the resumed sandbox and start a new one in its place. Everything
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
    // A resumed hosted sandbox being walked away from keeps existing (it is the user's, with their files) —
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
    // The provisioned machine belongs to the abandoned sandbox — the next one has no machine yet, and keeping
    // the stamp would freeze its mint (see the watcher below) for a VM that claims someone else's code.
    cloudMachine.value = null;
    subdomain.value = ``;
    derivedPrefix.value = ``;
    // The attach lane's inputs described the sandbox being abandoned — a stale domain would otherwise be sitting
    // in the field, ready to be attached to whichever sandbox is created next.
    domain.value = ``;
    attachToken.value = ``;
    attachOutcome.value = undefined;
    renaming.value = false;
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
 * is hidden for the WHOLE install — the app's own window takes the frame while the script runs (windows.rs).
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
        // A provisioned cloud machine boots holding THE minted code — re-minting would overwrite it
        // server-side and the machine's claim would find a code that no longer exists. Once one exists, the
        // code is frozen with it.
        if (cloudMachine.value !== null) {
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
// SILENT, and it must stay that way. This fires the moment step 2 renders a command — the sandbox does not
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
                    <!-- Medium, not semibold, and every heading under it follows: at a screen's worth of dark
                         surfaces this page was set almost entirely in bold — page title, three step headings, the
                         panel's — and a hierarchy in which everything is emphasised has none. Size and colour
                         carry it now; weight only marks the step you are being asked to read. -->
                    <h1 class="min-w-0 flex-1 text-xl font-medium md:text-2xl">Set up your workspace</h1>
                    <!-- The promise has to match the lane: "a few minutes" and "use intentic's domain" describe
                         work the attach lane doesn't do. -->
                    <p class="w-full text-sm text-muted">
                        <template v-if="lane === `attach`"
                            >Point intentic at the sandbox you're already running. One address, and you're in.</template
                        >
                        <template v-else
                            >A few minutes to a live sandbox, no Cloudflare account required. Use intentic's domain, or bring your own.</template
                        >
                    </p>
                </div>
            </header>

            <!-- Two columns from xl: the steps, and a docked reference panel that stops covering them. Below xl
                 this is the same single column as before and the panel folds back into step 2's (i) hint.
                 `items-start` is what lets the panel stick while the steps scroll past it. -->
            <div class="flex flex-col gap-3 md:gap-4 xl:flex-row xl:items-start xl:gap-6">
                <div class="flex min-w-0 flex-1 flex-col gap-3 md:gap-4 xl:max-w-3xl">
                    <!-- THE ATTACH LANE'S WHOLE FLOW: one address for a sandbox that is already running and
                         reachable. It keeps a titled card because it ASKS for something — a card with a form on
                         it and no heading is a form nobody knows the purpose of — and it takes an icon rather
                         than a number, since it is the whole flow and a "1" would promise a step 2 that is never
                         coming. -->
                    <StepSection v-if="lane === `attach`" icon="link" title="Connect your sandbox">
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
                            <span v-else class="text-xs text-muted">The https address your sandbox already answers on (https:// is optional).</span>
                        </label>

                        <!-- The SAME `name` the rename box binds, so switching lanes never loses what was typed.
                     It arrives filled in — the row was created on the way in — and Connect commits whatever
                     is in it, so this lane asks for a domain and nothing else unless the user wants to. -->
                        <label class="ui-field">
                            <span class="ui-field-label">Name</span>
                            <input
                                v-model="name"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="e.g. work, staging, my-laptop"
                                :class="cmp.input('w-full font-mono text-base md:text-sm')"
                                @keydown.enter="connectDomain"
                            />
                            <span class="text-xs text-muted">Just so you can tell it apart in the switcher.</span>
                        </label>

                        <!-- Each probe failure names the one thing the user can do about it. -->
                        <div v-if="attachOutcome?.kind === `unreachable`" :class="cmp.alertDanger('flex flex-col gap-1')">
                            <span>Nothing answered at that address.</span>
                            <span class="text-2xs opacity-80">
                                Check the sandbox is running and the domain points at it. The daemon's <code>WEB_ORIGIN</code> also has to name
                                <span class="font-mono">{{ webOrigin() ?? PLATFORM_WEB_ORIGIN }}</span
                                >. Otherwise your browser blocks the call before it's sent.
                            </span>
                        </div>
                        <div v-else-if="attachOutcome?.kind === `timeout`" :class="cmp.alertDanger('flex flex-col gap-1')">
                            <span>That address accepted the connection but never answered.</span>
                            <span class="text-2xs opacity-80">
                                Something is listening, but it isn't replying: a sandbox still starting up, or a proxy pointed at the wrong port. Give
                                it a moment and try again.
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
                                    Used once to claim the sandbox. The daemon stops asking once you're bound, so intentic never stores it.
                                </span>
                            </label>
                        </template>
                        <div v-else-if="attachOutcome?.kind === `denied`" :class="cmp.alertDanger('flex flex-col gap-1')">
                            <span>{{ attachOutcome.message }}</span>
                            <span class="text-2xs opacity-80">Ask its owner to invite {{ user?.email }}, then connect it again.</span>
                        </div>
                        <Notice
                            v-else-if="attachOutcome?.kind === `rejected`"
                            :of="{ tone: `danger`, title: `That sandbox refused the connection.`, detail: attachOutcome.message }"
                        />

                        <Notice v-if="error" :of="error" />
                        <!-- With a row already in hand, going back CONTINUES that sandbox through the run step rather
                     than setting a new one up — the label has to say which of the two it is. -->
                        <button type="button" :class="cmp.linkButton(`text-muted underline hover:text-content`)" @click="setLane(`provision`)">
                            {{ created === null ? `← Set one up for me instead` : `← Get a domain from intentic instead` }}
                        </button>
                    </StepSection>

                    <!-- THE SANDBOX, AS FACTS RATHER THAN A STEP: what it is called, and where it will answer.
                         Both are already true when the card renders — created on arrival, address provisioned
                         right behind it — so it asks for nothing, and a card that asks for nothing has no
                         business wearing a step number or a heading. "Your sandbox" above a row labelled "Name"
                         and a row labelled "Address" was a title that only restated the two labels under it.
                         The card chrome is StepSection's own, spelled out here because this is the one card on
                         the page that is deliberately not a step. -->
                    <section v-else class="flex flex-col gap-3 rounded-2xl border border-line bg-card p-4 md:p-5">
                        <!-- No row yet, which on this lane means the arrival create is in flight or has failed —
                             never a form waiting to be filled in. Both states are one line, because neither is
                             something the user has to do anything about. -->
                        <template v-if="created === null">
                            <p v-if="creating" class="flex items-center gap-2 text-xs text-muted">
                                <Icon name="spinner" spin class="text-info" />
                                Setting one up for you. Nothing to fill in.
                            </p>
                            <template v-else>
                                <Notice v-if="error" :of="error" />
                                <Button label="Try again" class="w-full justify-center md:w-auto" @click="autoCreate">
                                    <template #icon><Icon name="refresh" /></template>
                                </Button>
                            </template>
                            <!-- The one-step lane, kept to a single line: it costs the common path nothing and the
                             user who needs it is looking for exactly these words. -->
                            <button type="button" :class="cmp.linkButton()" @click="setLane(`attach`)">
                                Already running a sandbox somewhere? Connect it by domain →
                            </button>
                        </template>
                        <template v-else>
                            <template v-if="resuming">
                                <!-- Two different histories, and only one of them is a reconnect. A sandbox that
                                     ran before was torn down locally; one that was made here and never started is
                                     simply where the user left off — telling them a container was cleared would
                                     be describing a machine that never existed. -->
                                <p class="text-xs text-muted">
                                    <template v-if="neverStarted">
                                        This one was made last time you were here but never started. Pick up where you left off, or create a new
                                        sandbox instead.
                                    </template>
                                    <template v-else>
                                        This sandbox still exists on the platform; the CLI cleanup only cleared its local container. Reconnect it
                                        below to start a fresh daemon, or create a new sandbox instead.
                                    </template>
                                </p>
                                <button type="button" :class="cmp.linkButton(`text-muted underline hover:text-content`)" @click="startFresh">
                                    Not this one? Create a new sandbox instead
                                </button>
                            </template>
                            <!-- THE NAME, AS A LINE RATHER THAN A HEADING. Nobody typed it, so the row that reports
                                 it is also where it is changed — and the change is a pencil, not a sentence: the
                                 card used to spend a paragraph explaining that the name was a default and a link
                                 saying so again, which is three lines of apology for a word the user can simply
                                 overwrite. The label is muted and the name is mono, so the value is the thing the
                                 eye lands on. Never a gate: the command below is ready whether or not this is
                                 ever touched. -->
                            <!-- STRICTLY IN PLACE, the way the sandbox settings header renames: pressing the pencil
                                 used to replace this row with a stacked field and two labelled buttons, which moved
                                 every glyph on the card and shoved the run step down the page — a jump, on a card
                                 whose whole job is to sit still while you read it. -->
                            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span :class="factLabel">Name</span>
                                <!-- The name and the field it becomes share ONE grid cell at one type scale, one
                                     height and one padding, so switching modes paints a border and nothing else.
                                     The hidden sizer gives the field the width of the text it holds instead of the
                                     whole row — with `size="1"` on the input, which is what lets it: an input
                                     carries an intrinsic width of about twenty characters, and in a `w-fit` cell
                                     THAT is what decided the column, so the field opened ~100px wider than the
                                     name and shoved the two buttons beside it sideways. Same jump, last axis.
                                     THE ADDRESS BELOW WEARS THE SAME EMPTY SLOT (`factSlot`), which is what makes
                                     the two values start on one column: the padding a field needs to be typed in
                                     would otherwise push the name a few pixels right of an address that has none,
                                     and paying it back with a negative margin means hard-coding a spacing token
                                     this theme is free to change. -->
                                <div class="grid w-fit max-w-full min-w-0 grid-cols-1 grid-rows-1">
                                    <template v-if="renaming">
                                        <span aria-hidden="true" :class="`${factSlot} invisible col-start-1 row-start-1 whitespace-pre`">{{
                                            name === `` ? ` ` : name
                                        }}</span>
                                        <input
                                            ref="nameInput"
                                            v-model="name"
                                            aria-label="Sandbox name"
                                            autocomplete="off"
                                            size="1"
                                            spellcheck="false"
                                            :class="`${factSlot} col-start-1 row-start-1 w-full border-line-strong bg-canvas outline-none`"
                                            @keydown.enter="saveName"
                                            @keydown.esc="cancelRename"
                                        />
                                    </template>
                                    <span v-else :class="`${factSlot} col-start-1 row-start-1`"
                                        ><span class="truncate">{{ created.name }}</span></span
                                    >
                                </div>
                                <!-- Pencil and the commit pair stack in one cell too, so the cell is as wide as the
                                     wider of them and revealing Save cannot push anything sideways. The idle layer
                                     is `invisible`, which keeps its size while leaving the tab order.
                                     32px rather than the recipe's 24: these are not in a toolbar of their peers,
                                     they are alone beside a line of text on a card people reach on a phone. And a
                                     step dimmer than the recipe's muted — the name is the thing being read here,
                                     and an affordance beside one word should not compete with it. -->
                                <div class="grid grid-cols-1 grid-rows-1 items-center">
                                    <div class="col-start-1 row-start-1 flex items-center" :class="renaming ? `invisible` : ``">
                                        <button
                                            type="button"
                                            :class="cmp.iconButton(`h-8 w-8 text-subtle`)"
                                            aria-label="Rename sandbox"
                                            v-tooltip.bottom="`Rename sandbox`"
                                            @click="startRename"
                                        >
                                            <Icon name="pencil" />
                                        </button>
                                    </div>
                                    <div class="col-start-1 row-start-1 flex items-center gap-1" :class="renaming ? `` : `invisible`">
                                        <button
                                            type="button"
                                            :class="cmp.iconButton(`h-8 w-8 text-subtle hover:text-success`)"
                                            aria-label="Save name"
                                            v-tooltip.bottom="`Save · Enter`"
                                            @click="saveName"
                                        >
                                            <Icon :name="savingName ? `spinner` : `check`" :spin="savingName" />
                                        </button>
                                        <button
                                            type="button"
                                            :class="cmp.iconButton(`h-8 w-8 text-subtle`)"
                                            aria-label="Cancel rename"
                                            v-tooltip.bottom="`Cancel · Esc`"
                                            @click="cancelRename"
                                        >
                                            <Icon name="times" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <!-- THE ADDRESS, on the same grid as the name — the two facts this card reports, aligned.
                                 No padlock: the tunnel is https by construction, so the icon marked every address
                                 this page can ever show and therefore distinguished none of them — it was decoration
                                 sitting where a reader looks for the value. -->
                            <!-- A hosted sandbox's address is the daemon's own announce — no mint, no escape
                                 hatches: the machine was born holding its tunnel, and the page redirects the
                                 moment the address below turns real. -->
                            <template v-if="hostedRow !== null">
                                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span :class="factLabel">Address</span>
                                    <span v-if="hostedHost" :class="`${factSlot} break-words`">{{ hostedHost }}</span>
                                    <span v-else :class="`${factSlot} gap-2 text-xs text-muted`">
                                        <Icon name="spinner" spin /> Assigned as your machine starts…
                                    </span>
                                </div>
                            </template>
                            <template v-else-if="mode === `intentic`">
                                <!-- ONE ROW IN EVERY STATE (provisioned, still minting, or failed) so the escape
                                     hatch beside it is reachable in all three. It used to hang off the success
                                     branch alone, which left a reader whose mint had just errored with no way to
                                     choose a different address at all.
                                     THE SAME `gap-x-3` AND THE SAME `factSlot` AS THE NAME ROW, which together are
                                     the whole of what kept these two values from lining up: this row had a wider
                                     gap than that one, and its value sat flush while the name's sat inside the
                                     padding its field needs. Both facts start on one column now by construction
                                     rather than by arithmetic. -->
                                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span :class="factLabel">Address</span>
                                    <!-- `.title` — this is a NoticeModel, and interpolating the object itself put
                                         its JSON on the card. -->
                                    <span v-if="setupError" :class="`${factSlot} text-xs text-danger`">{{ setupError.title }}</span>
                                    <span v-else-if="setup" :class="`${factSlot} break-words`">{{ setup.hostname }}</span>
                                    <span v-else :class="`${factSlot} gap-2 text-xs text-muted`">
                                        <Icon name="spinner" spin /> Preparing your intentic domain…
                                    </span>
                                    <!-- ONE ESCAPE HATCH, NOT TWO. "Use my own Cloudflare zone instead" and "Already
                                         reachable at a domain? Connect it" were two links, in two places, asking the
                                         same question — how should this be reached — and the reader had to know the
                                         difference between provisioning under their zone and attaching an address
                                         that already answers BEFORE they could tell which link was theirs. Now one
                                         link opens both, each stating what it does rather than what it is called. -->
                                    <button type="button" :class="cmp.linkButton(`text-2xs`)" @click="reaching = !reaching">
                                        {{ reaching ? `Keep this address` : `Use a different address` }}
                                    </button>
                                </div>
                                <!-- The two ways off the default address, as one sentence. They were rows in a
                                     bordered inset with a caption each: a second frame, inside a card, to hold two
                                     choices that fit on one line. The labels carry the distinction, which is the
                                     only thing the captions were for. -->
                                <p v-if="reaching" class="text-xs text-muted">
                                    Use
                                    <button type="button" class="cursor-pointer text-link hover:underline" @click="chooseOwnZone">
                                        your own Cloudflare zone</button
                                    >, or connect
                                    <button type="button" class="cursor-pointer text-link hover:underline" @click="setLane(`attach`)">
                                        a domain it already answers on</button
                                    >.
                                </p>
                            </template>

                            <!-- Own Cloudflare: token + zone + editable subdomain. The way back sits on a row with
                                 the (i) that explains the token, which is the corner the step header used to keep
                                 it in — this card has no header to hang it off any more. -->
                            <template v-else>
                                <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                    <button v-if="intenticAvailable" type="button" :class="cmp.linkButton()" @click="mode = `intentic`">
                                        ← Use intentic's domain
                                    </button>
                                    <InfoHint label="Why the Cloudflare API token is required">
                                        <p class="mb-1 text-sm font-medium text-content">Why this token?</p>
                                        <p class="mb-3 text-2xs leading-relaxed text-muted">
                                            intentic reaches your sandbox over a private Cloudflare tunnel, with no open inbound ports.
                                        </p>
                                        <ul class="flex flex-col gap-2 text-2xs text-muted">
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
                                     to its own line rather than stealing width from the one part that is editable — an
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

                            <Notice v-if="error" :of="error" />
                        </template>
                    </section>

                    <!-- Step 2: run the sandbox — and the whole reason this page loses people. A copy-paste command is
                 no more dangerous than an .msi, but it arrives without any of an installer's affordances: no
                 publisher, no preview of what will happen, no list of what it changes, no uninstaller.
                 The wait folded in here too: watching for the daemon asked nothing of the user, so a card of its
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

                    <!-- No number on the badge. The card above it reports facts and asks for nothing, so it is not
                         a step and does not wear one — which leaves this as the only thing on the page anybody has
                         to DO, and a lone "2" beside an unnumbered card counts a spine that isn't there. The icon
                         says which kind of card this is instead, exactly as the attach lane's does. -->
                    <StepSection v-if="created && lane === `provision`" icon="terminal" :title="runTitle">
                        <template #actions>
                            <!-- Below xl only: from there up the same content is docked in its own column (see the
                         aside at the foot of this template), where it never lands on the command.
                         A bare (i) in the card's corner, not a captioned "What this does" chip: the caption
                         was a third row of text competing with the step's own instruction, and it sat where
                         a phone had to read past it to reach the button. The icon is the universal "more
                         about this" and it costs the card nothing. -->
                            <!-- Not on the hosted rung: the reference explains what the install does on the
                                 reader's machine, and on this rung nothing runs on any machine of theirs. -->
                            <InfoHint v-if="machine !== `hosted`" class="xl:hidden" label="What running your sandbox does">
                                <SetupRunDetails :cleanup="cleanupCommand" />
                            </InfoHint>
                        </template>

                        <!-- THE LADDER — first on the card because everything under it is the answer to it: how
                             much machine, whose, at what cost. The instant rung is where a first run lands by
                             itself; the caption under the picker is each rung's one honest line. A phone opens
                             on `cloud` when there is no hosted rung: it is the one classic path a phone finishes
                             without a second computer. Hidden in the desktop app, where "this computer" is the
                             whole point of being in the app. -->
                        <template v-if="ladderShown">
                            <Segmented :model-value="machine" :options="ladderOptions" :stretch="mobile" @update:model-value="setMachine" />
                            <p class="text-2xs text-muted">{{ machineCaption }}</p>
                        </template>

                        <!-- The hosted wait: nothing to run and nothing to copy — the platform is doing the work,
                             so for once a spinner is honest. The redirect fires from the same announce watch every
                             other lane uses. -->
                        <template v-if="machine === `hosted`">
                            <p v-if="creating" class="flex items-center gap-2 text-sm text-content">
                                <Icon name="spinner" spin class="text-info" />
                                Creating your sandbox…
                            </p>
                            <template v-else-if="hostedRow !== null">
                                <p class="flex items-center gap-2 text-sm text-content">
                                    <Icon name="spinner" spin class="text-info" />
                                    Starting your machine. You'll be taken in as soon as it answers.
                                </p>
                                <p class="text-xs text-muted">
                                    <template v-if="hostedSlow">
                                        Taking longer than usual. It keeps trying on its own, so you can leave this page open or come back later.
                                    </template>
                                    <template v-else>Usually under a minute. Nothing to install, nothing to paste.</template>
                                </p>
                            </template>
                            <Button v-else-if="!creating" label="Try again" class="w-full justify-center md:w-auto" @click="hostedAutoCreate">
                                <template #icon><Icon name="refresh" /></template>
                            </Button>
                        </template>

                        <!-- The command carries the chosen path's values, so we don't reveal it until that path is ready — a
                     command missing the token/zone/subdomain or the provisioned tunnel would just fail in the sandbox. -->
                        <div
                            v-else-if="!commandReady"
                            class="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-4 text-xs text-muted"
                        >
                            <Icon name="lock" class="mt-0.5 shrink-0" />
                            <span>{{ lockedReason }}</span>
                        </div>
                        <template v-else>
                            <template v-if="machine === `cloud` && cloudOffered">
                                <!-- The machine boots headless with no Cloudflare of its own, so only the
                                     intentic-provided tunnel can make it reachable — a step-2 own-zone pick has
                                     to be walked back before the form is any use. -->
                                <p v-if="mode !== `intentic`" class="flex items-start gap-2 text-xs text-muted">
                                    <Icon name="info-circle" class="mt-0.5 shrink-0" />
                                    <span>Cloud machines use intentic's domain. Switch the address above back to intentic's to create one.</span>
                                </p>
                                <!-- Provisioned: the form's work is done, and the one fact worth keeping on screen
                                     is where the machine lives — the wait below narrates the rest. -->
                                <p v-else-if="cloudMachine" class="flex items-start gap-2 text-xs text-muted">
                                    <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                                    <span class="min-w-0">
                                        <span class="font-mono text-content">{{ cloudMachine.serverName }}</span> was created in your
                                        {{ cloudProviderLabel }} account ({{ cloudMachine.location }}). It sets itself up from first boot.
                                    </span>
                                </p>
                                <SetupCloud v-else-if="created" :sandbox-id="created.id" @provisioned="onProvisioned" />
                            </template>
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
                                        Installs Docker if you need it, starts your sandbox and its tunnel, and opens your workspace the moment it
                                        answers. No terminal.
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
                                            <template v-else>Paste it into a terminal: this computer, or any server you have a shell on.</template>
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
                                            <p class="mt-1 pl-6 text-2xs">
                                                This command builds <code>{{ DEV_SANDBOX_IMAGE }}</code> from your checkout and runs that. Every run
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
                                <p v-if="!desktop && !mobile && runTab !== `compose`" class="border-t border-line pt-3 text-2xs text-subtle">
                                    Rather not use a terminal?
                                    <button type="button" class="text-link hover:underline" @click="runHere">Open the Intentic app</button>, or
                                    download it for <a :href="DESKTOP_DOWNLOADS.windows" class="text-link hover:underline">Windows</a>,
                                    <a :href="DESKTOP_DOWNLOADS.linuxAppImage" class="text-link hover:underline">Linux AppImage</a>,
                                    <a :href="DESKTOP_DOWNLOADS.linuxDeb" class="text-link hover:underline">.deb</a> or
                                    <a :href="DESKTOP_DOWNLOADS.linuxRpm" class="text-link hover:underline">.rpm</a>.
                                    <!-- Local dev: these point at the local site's /desktop/ assets, so the links serve
                                         YOUR build once staged — the same story as the dev sandbox image above. -->
                                    <span v-if="platformUrlOverride" class="text-warning">
                                        Local dev: stage installers with <code>pnpm --filter @intentic/desktop-app stage:downloads</code> first.
                                    </span>
                                </p>
                            </template>
                        </template>

                        <!-- The wait's whole job, as the footer of the step it reports on — now saying WHICH of the two
                     waits this is. A spinner from the moment a code was minted is what made a screen where the
                     user has done nothing look identical to one where Docker is four minutes into an image
                     pull, and "your workspace opens automatically" is a promise about the second that reads, in
                     the first, as permission to sit still.
                     So the icon leads, and it SPINS IN EVERY STATE, because in every state something is
                     genuinely running: the registry poll, every 3s, for as long as this card is on screen.
                     The idle state used to get a static dot instead, to keep a spinner from claiming progress
                     the platform wasn't making — but that reads as a page that has stopped, and the fix for
                     "the platform is doing this for you" belongs in the WORDS, which is where it is now: the
                     line names the person whose move it is. Colour carries the difference the spin doesn't —
                     subtle while we're waiting on the user, info once it's out of their hands, success once a
                     machine has it.
                     There is no "Check now" here any more. The registry is polled every 3s regardless, so the
                     button re-asked a question already being asked and bought nothing but its own presence —
                     and because the poll shares `checking`, it spent every third second flipping itself to
                     "Checking…" and back, which is a card that looks broken while it works perfectly. -->
                        <div v-if="waiting" class="flex flex-col gap-2 border-t border-line pt-3">
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
                                    <!-- The machine narrating its own stage beats the canned guess — "Starting
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
                                         they could act on — the one fact this state has is whose move it is, so
                                         it says that instead. In the app there is no command to name and the
                                         button has a label, so it names the button. -->
                                    <template v-else-if="machine === `cloud` && cloudOffered">
                                        <span class="font-medium text-content">Waiting for you to create the machine.</span> Paste a credential above
                                        and press "Create the machine". Nothing runs (or costs anything) until you do.
                                    </template>
                                    <template v-else-if="desktop && !commandVisible">
                                        <span class="font-medium text-content">Waiting for you to start it.</span> Nothing runs until you press "Set
                                        it up now" above.
                                    </template>
                                    <template v-else>
                                        <span class="font-medium text-content">Waiting for you to run the command.</span> We'll notice the moment your
                                        sandbox starts.
                                    </template>
                                </span>
                            </p>

                            <!-- The machine said exactly what broke — render it verbatim, problem and fix per check,
                                 and the one instruction that is always true. This is the card the whole report
                                 channel exists for: the answer used to live in a terminal nobody was watching. -->
                            <div v-if="reportFailures !== null" :class="cmp.alertDanger(`flex flex-col gap-2`)">
                                <p class="flex items-start gap-2">
                                    <Icon name="exclamation-circle" class="mt-0.5 shrink-0" />
                                    <span class="min-w-0 font-medium">Setup failed on your machine. Here is what it found:</span>
                                </p>
                                <ul class="flex flex-col gap-1.5 pl-6">
                                    <li v-for="failure in reportFailures" :key="failure.check" class="min-w-0">
                                        <span class="font-medium">{{ failure.check }}:</span> {{ failure.problem }}
                                        <span v-if="failure.remedy !== ``" class="opacity-90"> Fix: {{ failure.remedy }}</span>
                                    </li>
                                </ul>
                                <p class="pl-6 text-2xs opacity-90">Fix the above, then run the same command again. It stays valid.</p>
                            </div>

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
                                    <!-- A created cloud machine that has not claimed after its long fuse is the one
                                         state where the provider's console is the next place to look — the boot log
                                         there says what the first boot actually did. -->
                                    <span v-if="cloudMachine" class="min-w-0">
                                        <span class="font-medium">Still building.</span> Check
                                        <span class="font-mono">{{ cloudMachine.serverName }}</span> in your {{ cloudProviderLabel }} console. Its
                                        boot log is <code>/var/log/cloud-init-output.log</code>. Deleting the machine there and creating a fresh
                                        sandbox here is always safe.
                                    </span>
                                    <span v-else-if="mobile && emailed" class="min-w-0">
                                        <span class="font-medium">Still nothing.</span> Open the link we emailed you on the computer that will host
                                        your sandbox. The command is waiting there.
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
                                        <span class="font-medium">Still nothing.</span> Check the Intentic window. It shows what the setup is doing,
                                        and any error it hit.
                                    </span>
                                    <span v-else class="min-w-0">
                                        <span class="font-medium">Still nothing.</span> Nothing starts until you press "Set it up now" above.
                                    </span>
                                </p>
                                <!-- After three minutes, stop assuming it was never run and start helping the person
                             whose terminal answered back. Both readings get an action they can take. -->
                                <p v-if="stalled && commandVisible && !cloudMachine" class="pl-6 text-2xs opacity-90">
                                    Already ran it? Check that terminal: an error there stops the sandbox before it can report in. Safe to run again.
                                </p>
                                <!-- `cta`, because in this banner copying again IS the way out — the quiet chip
                                     that suits a copy-beside-content read as the dimmest thing in the loudest
                                     box on the card. self-start, or the column flex stretches it edge to edge.
                                     Except on a phone that has mailed itself the link, where copying again is
                                     not the way out of anything: the clipboard was never the blocked step. -->
                                <CopyButton
                                    v-if="commandVisible && runTab !== `compose` && !(mobile && emailed) && !cloudMachine"
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
                                    >Picked up a while ago, still no sandbox. Check
                                    {{
                                        launched
                                            ? `the Intentic window`
                                            : cloudMachine
                                              ? `the machine's boot log in your ${cloudProviderLabel} console`
                                              : `that terminal`
                                    }}
                                    for an error. It's safe to re-run.</span
                                >
                            </p>
                        </div>
                        <p v-if="status" class="text-2xs text-warning">{{ status }}</p>
                    </StepSection>
                </div>

                <!-- The docked half of the run step's reference material (SetupRunDetails carries the reasoning).
                     Present only while the run step is, because it is that step's material and nothing else's — the
                     attach lane runs no command and has nothing to explain here. `hidden` below xl: the same
                     content is on the run step's (i) hint there, and the hint's trigger is `xl:hidden` in turn, so
                     exactly one of the two is reachable at any width.
                     The width is measured, not picked: 22rem is what the longest cleanup one-liner (the sh
                     one, 44 mono characters at text-2xs) needs to sit on a single line inside the card's
                     padding. At 18rem it wrapped into three lines — the undo read as a paragraph. -->
                <aside v-if="created && lane === `provision` && machine !== `hosted`" class="hidden xl:sticky xl:top-8 xl:block xl:w-88 xl:shrink-0">
                    <div class="rounded-2xl border border-line bg-card p-4">
                        <SetupRunDetails :cleanup="cleanupCommand" />
                    </div>
                </aside>
            </div>
        </div>
    </div>
</template>
