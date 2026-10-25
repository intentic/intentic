import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ApiToken, HostedPlanState, User } from "@intentic/api-contract";
import type { LocalFound } from "@intentic/web/local-host";
import type {
    AccountAnswer,
    AccountAsk,
    DesktopInfo,
    FolderSetup,
    FolderStanding,
    HomeFacts,
    LocalRecent,
    LocalRoster,
    LocalSandbox,
    MachineEnvironment,
    OnboardingPrefetch,
    OnboardingSetup,
    OnboardingSnapshot,
    ProjectAsk,
    ProjectCreated,
    ProjectPreview,
    SandboxStatus,
    SetupArgs,
    UpdateStage,
} from "../src/desktop";
import { followCopy } from "./devCopy";
import { keyringVerb } from "./devKeyring";
import { CHECK_CANT_RUN, CHECK_NEEDS_SETUP, CHECK_READY, CHECK_UNKNOWN } from "./devOnboarding";

// Dev-server-only Tauri IPC fixtures let the real host/store run in a plain browser; production builds exclude this module.
// ?machine=fresh|host|setup chooses the PC; ?sandbox=creating|docker|waiting|failed|behind drives folder setup and first copy.
// ?project=new|cautions|refused|fail drives the folder action; ?pc=<state> drives this computer's setup, which blocks folders until ready.
// Choices persist across tab reloads. A signed-out fixture signs in before starting a folder's sandbox.

type Machine = `fresh` | `host` | `setup`;
const MACHINES: readonly Machine[] = [`fresh`, `host`, `setup`];
const MACHINE_KEY = `intentic.local.devMachine`;
// Set once the account signs out here (the account menu's Sign out), kept for the tab's reloads.
const SIGNED_OUT_KEY = `intentic.local.devSignedOut`;

const machineOf = (): Machine => {
    const asked = new URL(window.location.href).searchParams.get(`machine`);
    const known = MACHINES.find((machine) => machine === asked);
    if (known !== undefined) {
        sessionStorage.setItem(MACHINE_KEY, known);
        // A machine asked for by name starts signed in again, as it was set up.
        sessionStorage.removeItem(SIGNED_OUT_KEY);
        return known;
    }
    return MACHINES.find((machine) => machine === sessionStorage.getItem(MACHINE_KEY)) ?? `fresh`;
};

// A case kept for the tab's reloads under `key`: one picked on the address, or one a press moved the stand-in on to.
const keepCase = (key: string, kind: string): void => {
    sessionStorage.setItem(key, kind);
};

// A case picked by `?<param>=` on the dev address and kept for the tab's reloads under `key`; else the one kept; else
// `fallback`. Read at install, while the address still carries it.
const picked = <Case extends string>(param: string, key: string, cases: readonly Case[], fallback: Case): Case => {
    const asked = new URL(window.location.href).searchParams.get(param);
    const known = cases.find((kind) => kind === asked);
    if (known !== undefined) {
        keepCase(key, known);
        return known;
    }
    return cases.find((kind) => kind === sessionStorage.getItem(key)) ?? fallback;
};

const NOW_S = Math.floor(Date.now() / 1000);
const HOME = `C:\\Users\\ada`;

const recents: LocalRecent[] = [
    { path: `${HOME}\\intentic\\local`, folder: true, openedAt: NOW_S - 60, exists: true, sandbox: false },
    { path: `${HOME}\\Downloads\\urlopy-2026-12.xlsx`, folder: false, openedAt: NOW_S - 4 * 60, exists: true, sandbox: false },
    { path: `${HOME}\\Documents\\Taxes 2026`, folder: true, openedAt: NOW_S - 3 * 3600, exists: true, sandbox: false },
    { path: `${HOME}\\code\\shop`, folder: true, openedAt: NOW_S - 26 * 3600, exists: true, sandbox: true },
    { path: `${HOME}\\Desktop\\old-notes`, folder: true, openedAt: NOW_S - 9 * 86_400, exists: false, sandbox: false },
];

// What this computer's AI tools say (src-tauri/src/found.rs): on a first launch, Claude Code and Codex signed in, and
// the folders their histories and the editors name, one of them in a WSL distro and one with a sandbox already.
const FOUND: LocalFound = {
    providers: [
        { provider: `claude`, tools: [`claude-code`], email: `ada@example.com`, plan: `max`, wsl: null },
        { provider: `codex`, tools: [`codex`, `hermes`], email: `ada@example.com`, plan: `plus`, wsl: `Ubuntu` },
    ],
    projects: [
        {
            path: `${HOME}\\code\\shop`,
            shown: `${HOME}\\code\\shop`,
            name: `shop`,
            sources: [`claude-code`, `vscode`],
            lastActive: NOW_S - 2 * 3600,
            wsl: null,
            git: true,
            sandbox: true,
        },
        {
            path: `\\\\wsl.localhost\\Ubuntu\\home\\ada\\api`,
            shown: `/home/ada/api`,
            name: `api`,
            sources: [`codex`, `claude-code`],
            lastActive: NOW_S - 5 * 3600,
            wsl: `Ubuntu`,
            git: true,
            sandbox: false,
        },
        {
            path: `${HOME}\\Documents\\thesis`,
            shown: `${HOME}\\Documents\\thesis`,
            name: `thesis`,
            sources: [`claude-code`],
            lastActive: NOW_S - 3 * 86_400,
            wsl: null,
            git: false,
            sandbox: false,
        },
        {
            path: `${HOME}\\IdeaProjects\\inventory`,
            shown: `${HOME}\\IdeaProjects\\inventory`,
            name: `inventory`,
            sources: [`jetbrains`],
            lastActive: NOW_S - 40 * 86_400,
            wsl: null,
            git: true,
            sandbox: false,
        },
    ],
};

// The account's sandboxes as the workspace last listed them: one here, one in the cloud, one somebody shared.
const SANDBOXES: LocalSandbox[] = [
    { id: `cm1shop`, name: `shop`, place: `device`, shared: false },
    { id: `cm2research`, name: `research`, place: `cloud`, shared: false },
    { id: `cm3kasia`, name: `kasia-site`, place: `shared`, shared: true },
];

const RESOURCES: NonNullable<SandboxStatus[`resources`]> = {
    memoryBytes: 8 * 1024 ** 3,
    cpus: 4,
    privileged: false,
    gpu: false,
    hostRuntime: [],
    overlayRuntime: [],
};

// A sandbox here, running the stable image with the share above, and what sets each case apart.
const box = (slug: string, more: Partial<SandboxStatus>): SandboxStatus =>
    Object.assign({ slug, container: `intentic-${slug}`, running: true, image: `ghcr.io/intentic/sandbox:stable`, resources: RESOURCES }, more);

const sandboxesOf = (machine: Machine): SandboxStatus[] =>
    machine === `host`
        ? [
              // Just updated, the version before still parked, and known to the platform: its card offers Open.
              box(`574ea8038415`, { name: `shop`, tunnelRunning: true, version: `1.318.0`, probationUntil: Date.now() + 3 * 3_600_000, platformId: `cm1shop` }),
              box(`8a8171848c91`, { name: `research`, running: false }),
              box(`b1e2c3d4e5f6`, { name: `wsl-work`, keptElsewhere: `linux` }),
              // Nothing named it, its image says no version, and it runs privileged.
              box(`sandbox-82789f4106b4`, { image: `ghcr.io/intentic/sandbox:dev`, resources: { ...RESOURCES, privileged: true }, version: `0.0.0` }),
          ]
        : [];

// This PC's environments as agents.rs reads them: Windows' own agent, and one in a running WSL distro.
const ENVIRONMENTS: MachineEnvironment[] = [
    { kind: `windows`, here: true, agent: true, running: true, ic: true },
    { kind: `wsl`, distro: `archlinux`, here: false, agent: true, running: true, ic: true },
];

const reportOf = (machine: Machine): string | null =>
    machine === `fresh`
        ? null
        : JSON.stringify({
              version: `1.318.0`,
              running: 8984,
              summary: `serving 1 sandbox, syncing 1 folder`,
              device: { links: [{ sandboxUrl: `https://shop-574ea8038415.intentic.app`, id: `574ea8038415` }] },
              sync: {
                  hostname: `ada-laptop`,
                  os: `win32`,
                  pairings: [{ sandboxId: `574ea8038415`, mode: `sync`, localDir: `${HOME}\\code\\shop`, mutagenStatus: `Watching for changes` }],
                  ports: [{ port: 5173, sandboxId: `574ea8038415`, state: `mirrored` }],
                  agent: { running: true, pid: 8984, installed: `1.318.0`, build: `1.318.0` },
                  capturedAt: Date.now(),
              },
          });

// The phases the setup scripts print (src/setupPlan.ts), as far as a download of the sandbox's image.
const SETUP_STEPS = [
    [`fetching-ic`, `Fetching the installer`],
    [`checking-docker`, `Docker is running`],
    [`preflight`, `This device can run a sandbox`],
    [`claiming-code`, `Setup code redeemed`],
    [`pulling-image`, `Downloading ghcr.io/intentic/sandbox:stable`],
] as const;

// A setup's run as the app streams it (scripts.rs `desktop://run`): a step every few seconds, for the page's plan.
const runSetup = async (): Promise<void> => {
    await emit(`desktop://run`, { kind: `started`, run: `setup`, log: `${HOME}\\AppData\\Local\\intentic\\setup.log` });
    for (const [phase, said] of SETUP_STEPS) {
        await emit(`desktop://run`, { kind: `line`, run: `setup`, stream: `stdout`, text: `intentic: [${phase}] ${said}` });
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    // Held here: a dev machine's setup never finishes, so the page can be looked at mid-run.
    await new Promise(() => undefined);
};

/* A FOLDER'S OWN SANDBOX (src-tauri/src/folder_setup.rs), made on its press (project.rs). */

type SandboxCase = `creating` | `docker` | `waiting` | `failed` | `behind`;
const SANDBOX_CASES: readonly SandboxCase[] = [`creating`, `docker`, `waiting`, `failed`, `behind`];
const SANDBOX_KEY = `intentic.local.devSandbox`;

const sandboxCaseOf = (): SandboxCase => picked(`sandbox`, SANDBOX_KEY, SANDBOX_CASES, `creating`);

const REQUIREMENT = {
    id: `wsl-features`,
    title: `Turn on Windows Subsystem for Linux`,
    problem: `Docker Desktop runs its engine in WSL 2, which is off on this PC.`,
    remedy: `Intentic turns it on; Windows asks for administrator once.`,
    action: `fixElevated`,
};

// allow(module-state): the stand-in's records, as the app keeps them in folder-setups.json
let records: FolderSetup[] = [];

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The fields a standing carries: the old one's go with it, or a reason or a phase would read as the new one's.
const STANDING_KEYS: ReadonlySet<string> = new Set([`state`, `phase`, `step`, `percent`, `left`, `reason`, `for`, `behind`]);

// Every change to one folder's record, written and sent to every window as the app sends it.
const change = async (path: string, next: Partial<FolderSetup> & FolderStanding): Promise<void> => {
    records = records.map((record) => {
        if (record.path !== path) {
            return record;
        }
        const kept = Object.fromEntries(Object.entries(record).filter(([key]) => !STANDING_KEYS.has(key)));
        // SAFETY: everything but the standing kept, and `next` carries a whole standing of its own.
        return { ...kept, ...next, updatedAt: Math.max(record.updatedAt + 1, Date.now()) } as FolderSetup;
    });
    await emit(`desktop://folder-setups`, records);
};

const recordOf = (path: string): FolderSetup | undefined => records.find((record) => record.path === path);

// The setup's phases as the scripts print them (the shared setup-progress record's order), with a cached image: 169 s.
const FOLDER_STEPS: readonly (readonly [string, string, number, number])[] = [
    [`checking-docker`, `this PC was found ready moments ago, so it is not checked again.`, 600, 3],
    [`fetching-ic`, `ic 1.345.0 is installed, so nothing is downloaded.`, 400, 6],
    [`preflight`, `preflight - checking this machine.`, 600, 9],
    [`claiming-code`, `redeeming the setup code.`, 1200, 13],
    [`pulling-image`, `using the sandbox image already on this machine.`, 800, 16],
    [`starting-sandbox`, `starting sandbox.`, 3000, 35],
    [`waiting-health`, `waiting for the sandbox daemon to come up.`, 3000, 55],
    [`desktop-sync`, `linking the folder to your sandbox.`, 3000, 80],
    [`verifying`, `verifying the sandbox is reachable end to end.`, 2000, 88],
    [`connecting-machine`, `connecting this device so you can manage its sandboxes from your browser.`, 2000, 95],
];

// The folder's setup, run through as the app runs it: stopped where `?sandbox=` says, else made and its copy followed in.
const runFolderSetup = async (path: string, consent = false): Promise<void> => {
    const kind = sandboxCaseOf();
    if (kind === `docker`) {
        await change(path, { state: `needsDocker`, reason: `notRunning` });
        return;
    }
    if (kind === `waiting` && !consent) {
        await change(path, { state: `waiting`, for: `consent`, requirements: [REQUIREMENT] });
        return;
    }
    const held = recordOf(path);
    const begun = { attempt: (held?.attempt ?? 0) + 1, startedAt: Date.now(), sandboxId: `cm5${held?.name ?? `shop`}`, slug: `sandbox-5a1e` };
    await change(path, { state: `creating`, percent: 0, left: 169, ...begun });
    for (const [phase, step, ms, percent] of FOLDER_STEPS) {
        await change(path, { state: `creating`, phase, step, percent, left: Math.round(1.69 * (100 - percent)) });
        await pause(ms);
        if (kind === `failed` && phase === `claiming-code`) {
            await change(path, {
                state: `failed`,
                reason: `the platform refused the setup code (it was already used).`,
                logPath: `${HOME}\\.intentic\\logs\\desktop-folder-setup.log`,
            });
            return;
        }
    }
    await change(path, { state: `copying`, made: true, madeAt: Date.now(), hostname: `sandbox-5a1e.sbx.intentic.dev` });
    if (projectCaseOf() === `fail`) {
        await pause(3000);
        await change(path, { state: `failed`, reason: `shop's sandbox works, but this folder isn't syncing to it. Its Devices page says why.` });
        return;
    }
    await followCopy(path, change);
};

// A sign-in back from the browser (auth.rs `complete`): every folder waiting on it signed in, then, once the session is read, made.
const signInFromBrowser = async (): Promise<void> => {
    const waiting = records.filter((record) => record.state === `signedOut`);
    if (waiting.length === 0) {
        return;
    }
    await pause(3000);
    for (const record of waiting) {
        await change(record.path, { state: `signedIn` });
    }
    await pause(2000);
    for (const record of waiting) {
        void runFolderSetup(record.path);
    }
};

/* A FOLDER'S WAY TO ITS SANDBOX (src-tauri/src/project.rs): the dialog's answer, and the folder's setup begun. */

type ProjectCase = `new` | `cautions` | `refused` | `fail`;
const PROJECT_CASES: readonly ProjectCase[] = [`new`, `cautions`, `refused`, `fail`];
const PROJECT_KEY = `intentic.local.devProject`;

const projectCaseOf = (): ProjectCase => picked(`project`, PROJECT_KEY, PROJECT_CASES, `new`);

const projectPreview = (machine: Machine): ProjectPreview => {
    const face = window.__INTENTIC_LOCAL__;
    const name = face?.name ?? `shop`;
    const path = face?.path ?? `${HOME}\\code\\${name}`;
    const kind = projectCaseOf();
    if (kind === `refused`) {
        return { kind: `refused`, refusal: { kind: `inside`, other: `${HOME}\\code` } };
    }
    return {
        kind: `new`,
        name,
        path,
        files: kind === `cautions` ? 60_000 : 128,
        bytes: kind === `cautions` ? 3.4 * 1024 ** 3 : 3_276_800,
        more: kind === `cautions`,
        large: kind === `cautions`,
        cautions: kind === `cautions` ? [{ kind: `synced`, service: `OneDrive` }] : [],
        signedIn: signedIn(machine),
        seconds: 169,
    };
};

const projectCreate = async (machine: Machine, ask: ProjectAsk): Promise<ProjectCreated> => {
    const face = window.__INTENTIC_LOCAL__;
    const path = face?.path ?? `${HOME}\\code\\${ask.project}`;
    const fresh: FolderSetup = { path, name: ask.project, state: `queued`, made: false, attempt: 0, askedAt: Date.now(), updatedAt: Date.now() };
    records = [...records.filter((record) => record.path !== path), fresh];
    await emit(`desktop://folder-setups`, records);
    if (!signedIn(machine)) {
        await change(path, { state: `signedOut` });
    } else if (!pcReady()) {
        // This PC not ready yet: the folder's setup waits for its own (folder_setup.rs `Waiting` for consent, no needs).
        await change(path, { state: `waiting`, for: `consent` });
    } else if (sandboxCaseOf() === `behind`) {
        void (async () => {
            await change(path, { state: `queued`, behind: `notes` });
            await pause(5000);
            await runFolderSetup(path);
        })();
    } else {
        void runFolderSetup(path);
    }
    return { kind: `started`, name: ask.project };
};

// The card's presses, played out as the app would, on the calling window's own folder.
const folderVerb = (command: string, args: InvokeArgs | undefined): Promise<void> | undefined => {
    const path = window.__INTENTIC_LOCAL__?.path ?? ``;
    switch (command) {
        case `folder_setup_retry`: {
            // SAFETY: the page's own desktop.ts sends it, as `folderSetupRetry` types it.
            const consent = args !== undefined && `consent` in args && args[`consent`] === true;
            void runFolderSetup(path, consent);
            return Promise.resolve();
        }
        case `folder_setup_check`:
            if (recordOf(path)?.state === `needsDocker`) {
                // SAFETY: Docker started from this window: the folder's setup carries on, as the app's next round would.
                keepCase(SANDBOX_KEY, `creating`);
                void runFolderSetup(path);
            }
            return Promise.resolve();
        case `folder_setup_dismiss`:
            records = records.filter((record) => record.path !== path);
            return emit(`desktop://folder-setups`, records);
        case `folder_setup_end_session`:
            return Promise.resolve();
        case `sign_in`:
            void signInFromBrowser();
            return Promise.resolve();
        default:
            return undefined;
    }
};

/** What a command answers: the app's own types, or nothing for a verb whose effect is elsewhere. */
type Answer =
    | AccountAnswer
    | DesktopInfo
    | HomeFacts
    | LocalRecent[]
    | LocalFound
    | LocalRoster
    | UpdateStage
    | SandboxStatus[]
    | MachineEnvironment[]
    | SetupArgs
    | OnboardingSnapshot
    | ProjectPreview
    | readonly FolderSetup[]
    | number
    | Promise<ProjectCreated>
    | string
    | boolean
    | null
    | Promise<void>
    | Promise<string>
    | { memoryBytes: number; cpus: number }
    | {
          folder: string;
          text: string;
          queuedAt: number;
          state: string;
          reason?: string;
      };

const DESKTOP_INFO: DesktopInfo = {
    version: `1.318.0`,
    os: `windows`,
    appUrl: `https://app.intentic.dev`,
    platformUrl: `https://api.intentic.dev`,
    installId: `dev`,
    analyticsAllowed: false,
    engineLimitSeconds: 300,
    fixLimitSeconds: 600,
};

const signedIn = (machine: Machine): boolean => machine !== `fresh` && sessionStorage.getItem(SIGNED_OUT_KEY) === null;

/* THIS PC'S OWN SETUP (src-tauri/src/onboarding.rs): the check made at launch, the download started then, and the setup
   behind "Set up this PC", in the app's own shapes, so onboarding/pc.ts maps them as it does in the app. */

type PcCase =
    | `ready`
    | `checking`
    | `unknown`
    | `needsSetup`
    | `metered`
    | `prefetchFailed`
    | `settingUp`
    | `needsYou`
    | `quiet`
    | `restart`
    | `restartScheduled`
    | `admin`
    | `signOut`
    | `failed`
    | `cantRun`
    | `taskFailed`;
const PC_CASES: readonly PcCase[] = [
    `ready`,
    `checking`,
    `unknown`,
    `needsSetup`,
    `metered`,
    `prefetchFailed`,
    `settingUp`,
    `needsYou`,
    `quiet`,
    `restart`,
    `restartScheduled`,
    `admin`,
    `signOut`,
    `failed`,
    `cantRun`,
    `taskFailed`,
];
const PC_KEY = `intentic.local.devPc`;

const pcCaseOf = (): PcCase => picked(`pc`, PC_KEY, PC_CASES, `ready`);

const FETCHING: OnboardingPrefetch = { state: `running`, done: 1_150_000_000, total: 2_900_000_000, attempt: 1 };
const LOG = `${HOME}\\.intentic\\logs\\pc-setup.log`;

const pcSnapshotOf = (kind: PcCase): OnboardingSnapshot => {
    const nowS = Math.floor(Date.now() / 1000);
    const needs = (setup: OnboardingSetup, prefetch: OnboardingPrefetch = FETCHING): OnboardingSnapshot => ({ check: CHECK_NEEDS_SETUP, prefetch, setup });
    switch (kind) {
        case `ready`:
        case `taskFailed`:
            return { check: CHECK_READY, prefetch: { state: `done`, done: 2_900_000_000, total: 2_900_000_000 }, setup: { state: `idle` } };
        case `checking`:
            return { check: null, prefetch: FETCHING, setup: { state: `idle` } };
        case `unknown`:
            return { check: CHECK_UNKNOWN, setup: { state: `idle` } };
        case `needsSetup`:
            return needs({ state: `idle` });
        case `metered`:
            return needs({ state: `idle` }, { state: `metered`, done: 0, total: 2_900_000_000 });
        case `prefetchFailed`:
            return needs(
                { state: `idle` },
                { state: `failed`, done: 1_150_000_000, total: 2_900_000_000, attempt: 2, failure: { phase: `image`, reason: `could not fetch ghcr.io/intentic/sandbox:stable ahead: connection reset by peer` } },
            );
        case `settingUp`:
            return needs({ state: `running`, step: `Turning on Windows features for Docker`, percent: 38 });
        case `needsYou`:
            return needs({ state: `running`, step: `Turning on Windows features for Docker`, percent: 12, needsYou: true });
        case `quiet`:
            return needs({ state: `running`, step: `Installing the intentic engine`, percent: 64, quietSince: nowS - 21 * 60, log: LOG });
        case `restart`:
            return needs({ state: `waiting`, for: `restart` });
        case `restartScheduled`:
            return needs({ state: `waiting`, for: `restart`, restartAt: nowS + 10 * 60 });
        case `admin`:
            return needs({ state: `waiting`, for: `admin` });
        case `signOut`:
            return needs({ state: `waiting`, for: `signOut` });
        case `failed`:
            return needs({ state: `failed`, reason: `ic docker prepare stopped: the Windows features could not be turned on (DISM exit 87).` });
        case `cantRun`:
            return { check: CHECK_CANT_RUN, setup: { state: `idle` } };
    }
};

let onboarding: OnboardingSnapshot = { check: null, setup: { state: `idle` } };

const pcReady = (): boolean => onboarding.check?.state === `ready` || onboarding.setup.state === `ready`;

const changeOnboarding = async (next: Partial<OnboardingSnapshot>): Promise<void> => {
    onboarding = { ...onboarding, ...next };
    await emit(`desktop://onboarding`, onboarding);
};

// "Set up this PC", played out in a few seconds: Windows' features, the engine, then ready, and this computer's own
// sandbox made after it on a signed-in machine. It answers once the run has ended, as the app's command does.
const PC_STEPS: readonly (readonly [string, number])[] = [
    [`Turning on Windows features for Docker`, 12],
    [`Turning on Windows features for Docker`, 38],
    [`Installing the intentic engine`, 64],
    [`Starting the intentic engine`, 88],
];
const runPcSetup = async (machine: Machine): Promise<void> => {
    for (const [step, percent] of PC_STEPS) {
        await changeOnboarding({ setup: { state: `running`, step, percent } });
        await pause(2000);
    }
    await changeOnboarding({ check: CHECK_READY, setup: { state: `ready` } });
    // The folders whose setups waited for this PC's own carry on, as the app's next round would take them.
    if (signedIn(machine)) {
        for (const record of records.filter((held) => held.state === `waiting` && held.for === `consent`)) {
            void runFolderSetup(record.path);
        }
    }
};

// Whether the page sent `name` as `value`: desktop.ts's `onboarding*` wrappers send named arguments, never raw bytes.
const sent = (args: InvokeArgs | undefined, name: string, value: string | boolean): boolean =>
    args !== undefined && !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array) && args[name] === value;

const onboardingVerb = (machine: Machine, command: string, args: InvokeArgs | undefined): Promise<void> | undefined => {
    switch (command) {
        case `onboarding_recheck`:
            return pause(1500).then(() => changeOnboarding({}));
        case `onboarding_set_up`:
            return onboarding.setup.state === `running` && !sent(args, `again`, true) ? Promise.resolve() : runPcSetup(machine);
        case `onboarding_pause`: {
            const prefetch = onboarding.prefetch;
            if (prefetch === undefined) {
                return Promise.resolve();
            }
            return changeOnboarding({ prefetch: { state: sent(args, `paused`, true) ? `paused` : `running`, done: prefetch.done, total: prefetch.total } });
        }
        case `onboarding_sign_out`:
            // As the app comes back after signing in: the parked setup finishes by itself.
            return pause(1500).then(() => changeOnboarding({ check: CHECK_READY, setup: { state: `ready` } }));
        case `onboarding_restart`: {
            if (sent(args, `when`, `now`)) {
                // As the app comes back from the restart: the setup finished, this PC ready.
                return pause(1500).then(() => changeOnboarding({ check: CHECK_READY, setup: { state: `ready` } }));
            }
            // In ten minutes, or put off to the next time Windows starts (which cancels one scheduled).
            const setup: OnboardingSetup = sent(args, `when`, `in10Minutes`)
                ? { state: `waiting`, for: `restart`, restartAt: Math.floor(Date.now() / 1000) + 10 * 60 }
                : { state: `waiting`, for: `restart` };
            return changeOnboarding({ setup });
        }
        default:
            return undefined;
    }
};

/** The first task kept while dev local face runs (first_task.rs). */
let devFirstTask: {
    folder: string;
    text: string;
    queuedAt: number;
    state: `queued` | `sending` | `sent` | `failed`;
    reason?: string;
} | null = null;

/* THE ACCOUNT, as the platform answers a local window's account calls through the app (src-tauri/src/account.rs): Ada,
   on a complimentary plan, with one API token. A rename or a new picture holds until the tab reloads. */
const ACCOUNT: User = { id: `u_ada`, email: `ada@example.com`, name: `Ada Lovelace`, image: null };
const PLAN: HostedPlanState = { enabled: true, onPlan: true, comped: true, priceUsd: 20 };
const TOKENS: ApiToken[] = [{ id: `tok_1`, label: `CI deploys`, scope: `provision`, createdAt: new Date(NOW_S * 1000 - 12 * 86_400_000).toISOString() }];

const replied = <Body>(body: Body, status = 200): AccountAnswer => ({ status, body: JSON.stringify(body), contentType: `application/json` });

const accountAnswer = (machine: Machine, ask: AccountAsk): AccountAnswer => {
    const route = ask.path.split(`?`)[0];
    if (!signedIn(machine)) {
        return route === `/api/auth/get-session` ? replied(null) : replied({ message: `Not signed in.` }, 401);
    }
    switch (route) {
        case `/api/auth/get-session`:
            return replied({ session: { id: `s_dev`, userId: ACCOUNT.id, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }, user: ACCOUNT });
        case `/api/auth/update-user`:
            Object.assign(ACCOUNT, JSON.parse(ask.body ?? `{}`));
            return replied({ status: true });
        case `/api/auth/sign-out`:
            sessionStorage.setItem(SIGNED_OUT_KEY, `yes`);
            return replied({ success: true });
        case `/rpc/hosted-plan`:
            return replied(PLAN);
        case `/rpc/tokens`:
            return replied({ tokens: TOKENS });
        case `/rpc/me/export`:
            return replied({ user: ACCOUNT, sandboxes: SANDBOXES });
        default:
            return replied({ message: `The stand-in has no answer for ${ask.method} ${ask.path}.` }, 404);
    }
};

// Every command the page reads back, answered for the machine chosen. A dialog answers yes, and picks nothing.
const ANSWERS = new Map<string, (machine: Machine) => Answer>([
    [`desktop_info`, () => DESKTOP_INFO],
    [`home_facts`, (machine) => ({ accountSeen: signedIn(machine), lastFace: `home`, hostsSandboxes: signedIn(machine), homeFolder: `${HOME}\\intentic\\local` })],
    [`local_recents`, () => recents],
    // A first launch finds what is offered; a machine set up long ago is offered the same, under its recents.
    [`found_on_machine`, () => FOUND],
    [
        `local_roster`,
        (machine) => (signedIn(machine) ? { account: { email: `ada@example.com`, name: `Ada Lovelace` }, sandboxes: SANDBOXES } : { account: null, sandboxes: [] }),
    ],
    [`update_state`, () => ({ kind: `current` })],
    [`docker_listening`, signedIn],
    [`docker_ready`, signedIn],
    [`hosts_sandboxes`, signedIn],
    [`docker_engine`, () => ({ memoryBytes: 16 * 1024 ** 3, cpus: 8 })],
    [`sandbox_list`, sandboxesOf],
    // A PC whose WSL distro runs its own agent beside Windows', keeping the third sandbox of `?machine=host`.
    [`machine_agents`, (machine) => (machine === `host` ? ENVIRONMENTS : [])],
    [`machine_report`, reportOf],
    [`take_pending_setup`, (machine) => (machine === `setup` ? { code: `dev`, name: `shop` } : null)],
    [`take_pending_docker`, () => false],
    [`take_pending_recreate`, () => null],
    [`take_pending_sync`, () => null],
    [`take_pending_fix`, () => null],
    [`resumable_setup`, () => null],
    [`project_preview`, projectPreview],
    [`folder_setups`, () => records],
    [`sandbox_logs`, () => `intentic: sandbox up\nlistening on :7777\n`],
    [`machine_restart`, () => `restarted`],
    [`plugin:dialog|confirm`, () => true],
    [`plugin:dialog|ask`, () => true],
    [`plugin:dialog|open`, () => null],
    [`first_task_read`, () => devFirstTask],
    [`first_task_take_draft`, () => null],
    [`onboarding_state`, () => onboarding],
    [`first_task_clear`, () => { devFirstTask = null; return null; }],
]);

const answer = (machine: Machine, command: string, args: InvokeArgs | undefined): Answer => {
    const answered = ANSWERS.get(command);
    if (answered !== undefined) {
        return answered(machine);
    }
    if (command === `account_relay` && args !== undefined && `ask` in args) {
        // SAFETY: the page's own src/account.ts and local/platform.ts send it, as `accountRelay` types it.
        return accountAnswer(machine, args[`ask`] as AccountAsk);
    }
    if (command === `project_create` && args !== undefined && `ask` in args) {
        // SAFETY: the page's own host.ts sends it, as `projectCreate` types it.
        return projectCreate(machine, args[`ask`] as ProjectAsk);
    }
    if (command === `first_task_queue` && args !== undefined && `folder` in args && `text` in args) {
        devFirstTask = {
            folder: String(args[`folder`]),
            text: String(args[`text`]),
            queuedAt: Math.floor(Date.now() / 1000),
            state: `queued`,
        };
        return null;
    }
    if (command === `first_task_pick_folder`) {
        return `${HOME}\\code\\my-app`;
    }
    const verb = keyringVerb(command, args) ?? folderVerb(command, args) ?? onboardingVerb(machine, command, args);
    if (verb !== undefined) {
        return verb;
    }
    if (command === `setup_run`) {
        // A setup handed over from the workspace holds mid-run, to be looked at.
        return runSetup();
    }
    // Every verb the page sends and does not read back (point, open, sign in, the workspace, a sandbox's power…): said on
    // the console, which is where a dev server's reader looks for it.
    console.warn(`[dev desktop] ${command}`, args ?? {});
    return null;
};

export const installDevDesktop = (): void => {
    const machine = machineOf();
    // Read now, while the address still carries it: the page rewrites its address before anything asks (local/main.ts).
    projectCaseOf();
    sandboxCaseOf();
    const pc = pcCaseOf();
    onboarding = pcSnapshotOf(pc);
    if (pc === `taskFailed`) {
        devFirstTask = {
            folder: `${HOME}\\code\\shop`,
            text: `Make the checkout page remember the last shipping address.`,
            queuedAt: NOW_S - 600,
            state: `failed`,
            reason: `That folder is already being synced with another sandbox.`,
        };
    }
    mockIPC((command, args) => answer(machine, command, args), { shouldMockEvents: true });
    // The window this page is, as the app labels it (windows.rs `HOME`, local.rs `files-<n>`): the main window's setup
    // titles its own window (src/device/title.ts), which asks which window it is.
    mockWindows(window.__INTENTIC_LOCAL__?.home === true ? `home` : `files-1`);
    console.warn(
        `[dev desktop] the app is stood in for as the "${machine}" machine, this PC "${pc}"; ?machine=${MACHINES.join(`|`)} and ?pc=${PC_CASES.join(`|`)} pick others`,
    );
};
