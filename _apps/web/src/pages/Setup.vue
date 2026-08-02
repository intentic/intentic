<script setup lang="ts">
import type { SandboxSummary, SetupCode, SetupCodeTarget } from "@intentic-app/api-contract";
import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { sandboxSubdomain, syncFolder } from "@intentic/sandbox-contract";
import { cmp, Code, commandLang, CopyButton, InfoHint, Segmented, StepSection, useDevice, useOsPreference } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { track } from "../composables/analytics";
import { apiClient } from "../composables/useApi";
import { errorMessage } from "../composables/useAsyncAction";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import CloudflareTokenField from "../components/CloudflareTokenField.vue";
import { useCloudflareZones } from "../composables/extensions/useCloudflareZones";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { environment } from "../environments/environment";
import { bashCommand, bashDownloadCommand, psCommand, psDownloadCommand, scriptUrl, type SplitCommand } from "../environments/scriptCommand";
import SetupCompose from "./SetupCompose.vue";
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
 * created, what it writes outside Docker and how to remove all of it, and offers the two switches that reshape
 * the command instead of leaving the reader to abandon it: `hasDocker` (drop the `sudo`, which is only ever there
 * to install Docker) and `review` (download and read the script, then run the file).
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
// Drives the two places a phone needs different CONTENT rather than different layout (which the md: classes
// below handle): the run tabs' labels and the size of the controls that carry them.
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
const step1Title = computed(() => {
    if (created.value !== null) {
        return resuming.value && lane.value === `provision` ? `Reconnect "${name.value}"` : `Sandbox: ${name.value}`;
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

/* The two controls over the SHAPE of the pasted command. Both exist because a copy-paste install is the point
 * people balk at — not because it does more than an .exe would, but because it arrives with none of an
 * installer's affordances: no publisher, no preview, no file list, no uninstaller. These give the command back
 * the two that are ours to give.
 *
 * `hasDocker` drops the `sudo`. It is in there for exactly one job — installing Docker when the machine has
 * none (connect.sh's require_root_to_install_docker states the same deal from the other side) — and for a
 * developer who already runs Docker it is the single most alarming token in the line. Not persisted: it is a
 * claim about the machine the user is about to paste into, which is not necessarily the one they are reading on.
 *
 * `review` splits the one-liner into download-and-read, then run. Deploy-only: local dev already runs the
 * checkout's own script by path, so there is nothing to fetch and the developer can read it in their editor. */
const hasDocker = ref(false);
const review = ref(false);
// The filename the review path downloads to — named after what it is, in the folder the user is standing in.
const SCRIPT_FILE = { unix: `intentic-connect.sh`, windows: `intentic-connect.ps1` } as const;
// Both switches read as checkboxes, not buttons: each answers a question the sentence beside it asks, and a
// pressed state is the answer. min-h-7 keeps them thumb-sized without breaking the text row they sit in.
// The shared min-width is what makes the two rows read as a pair rather than as two ragged sentences: their
// captions start in the same column at any width where both chips fit on their caption's line.
const chipClass = (on: boolean): string =>
    `inline-flex min-h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-2xs transition-colors md:min-w-[11.5rem] ${
        on ? `border-success/40 bg-success/10 text-success` : `border-line text-muted hover:border-line-strong hover:text-content`
    }`;

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
 *   • `pasted`  — they copied it, so we are waiting on their terminal rather than on our own infrastructure
 *   • `claimed` — a machine redeemed the setup code at /setup/claim: the command demonstrably ran, and the
 *                 minutes of invisible Docker work that follow are finally a wait this page has earned
 *
 * The `claimed` state is the one that needed a server change (Sandbox.setupCodeClaimedAt): the claim is the only
 * evidence the platform ever gets that the pasted command reached a machine, and without it the card cannot
 * tell "you haven't run it yet" from "it's running and slow" — which is exactly the ambiguity people resolve,
 * wrongly, by waiting. */
type Handoff = "locked" | "yours" | "pasted" | "claimed";

// This browser put the command on the clipboard. Page-level and persistent, unlike CopyButton's own 1.5s
// flash: it is the hinge the card turns on, not a button animation.
const copied = ref(false);
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
    return copied.value ? `pasted` : `yours`;
});

/* The card escalates on its own, because the failure it guards against is silent: someone who has not realised
 * the command has to be run somewhere else will never do anything this page can react to, so nothing but
 * elapsed time can trigger the correction. `armedAt` is when the command became runnable — reset by a re-mint,
 * which hands out a different command. */
const now = ref(Date.now());
const armedAt = ref<number | undefined>(undefined);
const clock = setInterval(() => (now.value = Date.now()), 1000);
watch(commandReady, (ready) => {
    armedAt.value = ready ? Date.now() : undefined;
});

// When the card stops being polite about the likeliest reason nothing has reached us — the command is still
// sitting on a clipboard. Long enough to walk to another machine; short enough to catch someone who has
// settled in to watch this page. The compose path is a file to paste into an editor and edited there, so the
// same nudge on that tab would fire at somebody doing exactly the right thing.
const nudgeAfterMs = computed(() => (runTab.value === `compose` ? 3 * 60_000 : 40_000));
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
const onCopied = (): void => {
    copied.value = true;
    track(`sandbox_command_copied`, { tab: runTab.value, review: review.value, sync: syncEnabled.value });
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
        // A fresh code is a fresh command, so the handoff starts over: the clipboard holds the old one, and the
        // server has just cleared the claim stamp this mirrors (see setupCode in sandbox.routes.ts).
        copied.value = false;
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
// The same install as download-then-run, for the reader who wants the script on disk before it executes.
// Undefined outside `review` (and outside production, where there is nothing to download) so the template
// switches on one value instead of restating the condition.
const splitCommand = computed<SplitCommand | undefined>(() => {
    const code = setup.value?.code;
    if (code === undefined || !review.value || !environment.production) {
        return undefined;
    }
    return cmdOs.value === `windows`
        ? psDownloadCommand(`ps1`, windowsEnv(code), SCRIPT_FILE.windows)
        : bashDownloadCommand(`sh`, linuxPrefix(), code, SCRIPT_FILE.unix);
});
const selectedCommandLang = computed(() => commandLang(cmdOs.value));
// The uninstaller, offered beside the installer: it removes every container, volume and network the command
// creates. Knowing the undo exists before you commit is most of what an .exe's Add/Remove entry is worth.
const cleanupCommand = computed(() => (cmdOs.value === `windows` ? psCommand(`cleanupPs1`, ``) : bashCommand(`cleanup`, ``, ``)));
// The script this step hands out, readable in a browser tab without running anything.
const sourceUrl = computed(() => scriptUrl(cmdOs.value === `windows` ? `ps1` : `sh`));

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
        image: `registry.gitlab.com/radarsu/intentic/sandbox:stable`,
        googleClientId: environment.auth.googleClientId,
        webOrigin: globalThis.location.origin,
        ...(platformUrlOverride.value ? { platformUrl: platformUrlOverride.value } : {}),
    };
});

// When the gate's "Open setup" carried a sandbox id, resume setup for that sandbox (name + steps 2-4) instead
// of a blank create form. Owned only — a member can't mint someone else's sandbox, so their id falls through
// to create. The check loop acts on the ACTIVE sandbox, so select it to make the URL self-contained.
onMounted(async () => {
    void refreshPlan(); // so atLimit is accurate even on a direct navigation to /setup
    const loaded = await sandbox.list();
    const requested = route.query[`sandbox`];
    const found = typeof requested === `string` ? loaded.find((entry) => entry.id === requested) : undefined;
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
    // The handoff belonged to the abandoned sandbox's command: a copy already made, and a claim already
    // recorded, are both facts about a machine the next sandbox has nothing to do with.
    copied.value = false;
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

// Watch the registry while we sit on /setup; the moment the daemon reports in, open the workspace.
const timer = setInterval(() => void check(), 3000);
onUnmounted(() => {
    clearInterval(timer);
    clearInterval(clock);
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
        const digest = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(token));
        const hex = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, `0`))
            .join(``);
        derivedPrefix.value = sandboxSubdomain(hex.slice(0, 12));
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
    <div class="min-h-dvh w-full overflow-auto bg-canvas text-content">
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
                                <p class="text-xs text-muted">
                                    This sandbox still exists on the platform — the CLI cleanup only cleared its local container. Reconnect it below
                                    to start a fresh daemon<template v-if="!atLimit">, or create a new sandbox instead</template>.
                                </p>
                                <!-- At the cap there is no second sandbox to offer, and the paragraph above already
                             said so — so the alternative simply isn't there, rather than becoming a sales
                             pitch aimed at someone in the middle of reconnecting a machine. -->
                                <button
                                    v-if="!atLimit"
                                    type="button"
                                    :class="cmp.linkButton(`text-muted underline hover:text-content`)"
                                    @click="startFresh"
                                >
                                    Not this one? Create a new sandbox instead
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
                 described, on exactly the screens with room to put it beside instead. -->
                    <StepSection v-if="created && lane === `provision`" :step="3" title="Run this on your computer">
                        <template #actions>
                            <!-- Below xl only: from there up the same content is docked in its own column (see the
                         aside at the foot of this template), where it never lands on the command. -->
                            <InfoHint class="xl:hidden" label="What running your sandbox does" text="What this does">
                                <SetupRunDetails :sync-enabled="syncEnabled" :cleanup="cleanupCommand" />
                            </InfoHint>
                        </template>

                        <!-- One line, because the title already gave the instruction and nobody reads the second
                     sentence of a step they are trying to get through. All this adds is the bit the title
                     can't: WHICH machine. On a phone it says the other thing instead — the device reading
                     this cannot be the device running it. -->
                        <p class="flex items-start gap-2.5 text-xs text-muted">
                            <Icon name="terminal" class="mt-0.5 shrink-0 text-link" />
                            <span class="min-w-0">
                                <template v-if="mobile">Copy it, then paste it into a terminal on the machine that will host your sandbox.</template>
                                <template v-else>Paste it into a terminal — this computer, or any server you have a shell on.</template>
                            </span>
                        </p>

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
                            <div class="flex flex-col gap-2">
                                <!-- On a phone the picker and the copy button each take a full row: three pill tabs
                             sharing a 340px line wrapped every label to two lines, and the copy chip that
                             trailed them is the one control this step exists for. The single Copy belongs to
                             the single command — the review path's two blocks each carry their own, because
                             the point of splitting them is that they are run one at a time. -->
                                <div class="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
                                    <Segmented v-model="runTab" :options="runTabOptions" :stretch="mobile" />
                                    <CopyButton
                                        v-if="runTab !== `compose` && splitCommand === undefined"
                                        :text="selectedCommand"
                                        :label="mobile ? `Copy command` : `Copy`"
                                        :stretch="mobile"
                                        @copied="onCopied"
                                    />
                                </div>
                                <SetupCompose v-if="runTab === `compose` && composeArgs" :args="composeArgs" />
                                <template v-else-if="splitCommand">
                                    <!-- The RUN half is the copy that means the handoff has started; copying the fetch
                                 half is halfway through reading the script, not halfway to a sandbox. -->
                                    <Code :code="splitCommand.fetch" :lang="selectedCommandLang" :wrap="true" label="1. Download it, and read it" />
                                    <Code
                                        :code="splitCommand.run"
                                        :lang="selectedCommandLang"
                                        :wrap="true"
                                        label="2. Run the file you just read"
                                        @copied="onCopied"
                                    />
                                </template>
                                <template v-else>
                                    <!-- Clamped on a phone: the command is a thing to COPY, and wrapped in full it is
                                 nine lines of env vars between the button that copies it and the step that
                                 comes next. The dev command is the long one, but even the hosted one-liner
                                 wraps to four lines at 390px.
                                 The label is the block's title bar, and one word is all it needs: a dark
                                 monospace box in a page of cards reads as a documentation snippet, and
                                 "Terminal" is what stops it. Which machine is the line above's job. -->
                                    <Code
                                        :code="selectedCommand"
                                        :lang="selectedCommandLang"
                                        :wrap="true"
                                        :copyable="false"
                                        label="Terminal"
                                        :clamp-lines="mobile ? 4 : undefined"
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
                                 Script tabs only — compose carries no SYNC_DIR and declares its own shape. -->
                            <div v-if="runTab !== `compose`" class="flex flex-col gap-1.5 text-2xs text-muted">
                                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <button
                                        type="button"
                                        :aria-pressed="syncEnabled"
                                        :class="chipClass(syncEnabled)"
                                        @click="syncEnabled = !syncEnabled"
                                    >
                                        <Icon :name="syncEnabled ? `check-square` : `square`" />
                                        Also sync a local folder
                                    </button>
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
                             names the reboot a first Windows install may want. -->
                                <div v-if="environment.production && runTab === `unix`" class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <button type="button" :aria-pressed="hasDocker" :class="chipClass(hasDocker)" @click="hasDocker = !hasDocker">
                                        <Icon :name="hasDocker ? `check-square` : `square`" />
                                        I already have Docker
                                    </button>
                                    <span class="min-w-0">
                                        <template v-if="hasDocker">Runs as you, no <code>sudo</code>.</template>
                                        <template v-else><code>sudo</code> is there for one job: installing Docker if it's missing.</template>
                                    </span>
                                </div>
                                <div v-if="environment.production" class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <button type="button" :aria-pressed="review" :class="chipClass(review)" @click="review = !review">
                                        <Icon :name="review ? `check-square` : `square`" />
                                        Download and read it first
                                    </button>
                                    <span class="min-w-0">
                                        <a
                                            :href="sourceUrl"
                                            target="_blank"
                                            rel="noreferrer"
                                            class="inline-flex items-center gap-1 text-link hover:underline"
                                        >
                                            Or read it here <Icon name="external-link" />
                                        </a>
                                    </span>
                                </div>
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
                                <Icon v-else-if="handoff === `pasted`" name="spinner" spin class="mt-0.5 shrink-0 text-info" />
                                <Icon v-else name="circle-fill" class="mt-1 shrink-0 text-[0.5rem] text-subtle" />
                                <span class="min-w-0">
                                    <template v-if="handoff === `claimed`">
                                        <span class="font-medium text-success">Your machine picked it up.</span> Starting Docker — the first run takes
                                        a few minutes.
                                    </template>
                                    <template v-else-if="handoff === `pasted`">
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
                                    <span class="min-w-0">
                                        <span class="font-medium">Still nothing.</span> This has to be pasted into a terminal on the machine that will
                                        run your sandbox.
                                    </span>
                                </p>
                                <!-- After three minutes, stop assuming it was never run and start helping the person
                             whose terminal answered back. Both readings get an action they can take. -->
                                <p v-if="stalled" class="pl-6 text-2xs opacity-90">
                                    Already ran it? Check that terminal — an error there stops the sandbox before it can report in. Safe to run again.
                                </p>
                                <!-- `cta`, because in this banner copying again IS the way out — the quiet chip
                                     that suits a copy-beside-content read as the dimmest thing in the loudest
                                     box on the card. self-start, or the column flex stretches it edge to edge. -->
                                <CopyButton
                                    v-if="runTab !== `compose` && splitCommand === undefined"
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
                                <span class="min-w-0"
                                    >Picked up a while ago, still no sandbox. Check that terminal for an error — it's safe to re-run.</span
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
