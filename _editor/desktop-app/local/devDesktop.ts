import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { ApiToken, HostedPlanState, User } from "@intentic/api-contract";
import type { AccountAnswer, AccountAsk, DesktopInfo, HomeFacts, LocalRecent, LocalRoster, LocalSandbox, SandboxStatus, SetupArgs, UpdateStage } from "../src/desktop";

// THE APP, STOOD IN FOR ON A DEV SERVER. The local face in a plain browser (`pnpm dev:local`) has no Tauri behind it, so
// every command the shell and This device call would throw. This answers them from a few fixed machines, through Tauri's
// own IPC mock, so the real host (src/host.ts) and the real store (src/device/useDevice.ts) run as they do in the app.
// Loaded only by a dev server outside the app (local/main.ts); a build never contains it.
//
// Which machine is chosen by `?machine=` on the dev address, kept for the tab's reloads:
// - `fresh` (the default): a first launch. No account, no sandbox, no agent, no Docker.
// - `host`: signed in, two sandboxes here (one running, with a folder synced) of the account's three, the machine agent up.
// - `setup`: signed in, a setup handed over from the workspace, running its steps.

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

const NOW_S = Math.floor(Date.now() / 1000);
const HOME = `C:\\Users\\ada`;

const recents: LocalRecent[] = [
    { path: `${HOME}\\intentic\\local`, folder: true, openedAt: NOW_S - 60, exists: true, sandbox: false },
    { path: `${HOME}\\Downloads\\urlopy-2026-12.xlsx`, folder: false, openedAt: NOW_S - 4 * 60, exists: true, sandbox: false },
    { path: `${HOME}\\Documents\\Taxes 2026`, folder: true, openedAt: NOW_S - 3 * 3600, exists: true, sandbox: false },
    { path: `${HOME}\\code\\shop`, folder: true, openedAt: NOW_S - 26 * 3600, exists: true, sandbox: true },
    { path: `${HOME}\\Desktop\\old-notes`, folder: true, openedAt: NOW_S - 9 * 86_400, exists: false, sandbox: false },
];

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

const sandboxesOf = (machine: Machine): SandboxStatus[] =>
    machine === `host`
        ? [
              { slug: `574ea8038415`, container: `intentic-574ea8038415`, name: `shop`, running: true, image: `ghcr.io/intentic/sandbox:stable`, tunnelRunning: true, resources: RESOURCES },
              { slug: `8a8171848c91`, container: `intentic-8a8171848c91`, name: `research`, running: false, image: `ghcr.io/intentic/sandbox:stable`, resources: RESOURCES },
          ]
        : [];

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

// A setup's run as the app streams it (scripts.rs `desktop://run`): a step every few seconds, which is what the page's
// plan moves on.
const runSetup = async (): Promise<void> => {
    await emit(`desktop://run`, { kind: `started`, run: `setup`, log: `${HOME}\\AppData\\Local\\intentic\\setup.log` });
    for (const [phase, said] of SETUP_STEPS) {
        await emit(`desktop://run`, { kind: `line`, run: `setup`, stream: `stdout`, text: `intentic: [${phase}] ${said}` });
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    // Held here: a dev machine's setup never finishes, so the page can be looked at mid-run.
    await new Promise(() => undefined);
};

/** What a command answers: the app's own types, or nothing for a verb whose effect is elsewhere. */
type Answer = AccountAnswer | DesktopInfo | HomeFacts | LocalRecent[] | LocalRoster | UpdateStage | SandboxStatus[] | SetupArgs | string | boolean | null | Promise<void> | { memoryBytes: number; cpus: number };

const DESKTOP_INFO: DesktopInfo = {
    version: `1.318.0`,
    os: `windows`,
    appUrl: `https://app.intentic.dev`,
    platformUrl: `https://api.intentic.dev`,
    installId: `dev`,
    engineLimitSeconds: 300,
    fixLimitSeconds: 600,
};

const signedIn = (machine: Machine): boolean => machine !== `fresh` && sessionStorage.getItem(SIGNED_OUT_KEY) === null;

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
    [`machine_report`, reportOf],
    [`take_pending_setup`, (machine) => (machine === `setup` ? { code: `dev`, name: `shop` } : null)],
    [`take_pending_docker`, () => false],
    [`take_pending_recreate`, () => null],
    [`take_pending_sync`, () => null],
    [`take_pending_fix`, () => null],
    [`resumable_setup`, () => null],
    [`setup_run`, () => runSetup()],
    [`sandbox_logs`, () => `intentic: sandbox up\nlistening on :7777\n`],
    [`machine_restart`, () => `restarted`],
    [`plugin:dialog|confirm`, () => true],
    [`plugin:dialog|ask`, () => true],
    [`plugin:dialog|open`, () => null],
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
    // Every verb the page sends and does not read back (point, open, sign in, the workspace, a sandbox's power…): said on
    // the console, which is where a dev server's reader looks for it.
    console.warn(`[dev desktop] ${command}`, args ?? {});
    return null;
};

export const installDevDesktop = (): void => {
    const machine = machineOf();
    mockIPC((command, args) => answer(machine, command, args), { shouldMockEvents: true });
    console.warn(`[dev desktop] the app is stood in for as the "${machine}" machine; ?machine=${MACHINES.join(`|`)} picks another`);
};
