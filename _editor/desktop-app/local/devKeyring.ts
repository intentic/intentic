import type { InvokeArgs } from "@tauri-apps/api/core";
import { sleep } from "@intentic/base/async";
import type { KeyringPendingNeed, KeyringRemember, KeyringState } from "@intentic/sandbox-contract/schemas/keyring";
import type { KeyringActivityLine, KeyringAppOp, KeyringAppOps, KeyringEntry, KeyringSettings, KeyringSourceStatus, KeyringStatus } from "../src/passwords/keyringCommands";

// The keyring's half of the app stood in for on a dev server (devDesktop.ts), kept apart from the rest of it.

/* THE KEYRING ON THIS COMPUTER (src-tauri/src/keyring.rs), as `intentic-machine keyring … --json` answers: one line of
   JSON. A SAMPLE vault, so the Passwords view can be looked at without a real one: about 25 entries across sites, apps,
   terminal prompts, a phone and notes, three of them just saved, one agent's request waiting, a record of use, the
   sources and settings. Every change takes a moment, standing in for the prompt the keyring raises on the computer, so
   "Confirm on this computer" can be seen. Nothing here is anybody's password.

   `?passwords=not-set-up` opens on the first run, `?passwords=locked` on a locked vault, `?passwords=old` on an agent
   too old to have Passwords: the dev page's own query, read once. */
const SHOP_URL = `https://shop-574ea8038415.intentic.app`;
const DEV_URL = `https://intentic-dev-2c8eb2c5b3a5.intentic.app`;
const MIN = 60_000;
const NOW = Date.now();

const devMode = new URLSearchParams(globalThis.location?.search ?? ``).get(`passwords`);
let setUp = devMode !== `not-set-up`;
let locked = devMode === `locked`;
let remember: KeyringRemember = { browser: true, terminal: true, apps: false, phone: false, sandbox: false };
let settings: KeyringSettings = { remember, rememberAskedAt: NOW - 86_400_000, neverSave: [{ kind: `site`, host: `bank.example.com` }], autoLockMinutes: 15, lockOnSleep: true };

interface Sample {
    readonly name: string;
    readonly title: string;
    readonly username?: string;
    readonly hosts?: readonly string[];
    readonly programs?: readonly string[];
    readonly packages?: readonly string[];
    readonly askpass?: readonly string[];
    readonly kind?: `password` | `text`;
    readonly captured?: KeyringEntry[`captured`];
    readonly fresh?: boolean;
    readonly shares?: KeyringEntry[`shares`];
    readonly health?: KeyringEntry[`health`];
    readonly note?: string;
    readonly versions?: number;
    readonly unverified?: boolean;
}

const share = (sandbox: string, mode: `each-use` | `while-here` | `copy`): KeyringEntry[`shares`][number] => ({ sandbox, machine: `ada-laptop`, mode, sharedAt: NOW - 3 * 86_400_000 });
const brave = (minutesAgo: number): KeyringEntry[`captured`] => ({ source: `browser`, via: `Brave`, at: NOW - minutesAgo * MIN });

const SAMPLES: readonly Sample[] = [
    { name: `GITHUB_COM`, title: `GitHub`, username: `ada`, hosts: [`github.com`], captured: brave(120), fresh: true, shares: [share(DEV_URL, `each-use`)], versions: 2 },
    { name: `SSH_ADA_BUILD_01`, title: `ssh ada@build-01`, username: `ada`, askpass: [`ssh:ada@build-01`], captured: { source: `askpass`, via: `ssh`, at: NOW - 300 * MIN }, fresh: true, unverified: true },
    { name: `FORTICLIENT`, title: `FortiClient`, username: `ada.lovelace`, programs: [`FortiClient.exe`], captured: { source: `app`, via: `FortiClient`, at: NOW - 26 * 60 * MIN }, fresh: true, shares: [share(DEV_URL, `while-here`)] },
    { name: `GITLAB_COM`, title: `GitLab`, username: `ada`, hosts: [`gitlab.com`], captured: brave(9000) },
    { name: `AWS_CONSOLE`, title: `AWS console`, username: `ada@analytical.engine`, hosts: [`signin.aws.amazon.com`], captured: brave(20_000), shares: [share(SHOP_URL, `each-use`)] },
    { name: `STRIPE_COM`, title: `Stripe`, username: `billing@analytical.engine`, hosts: [`dashboard.stripe.com`], captured: brave(40_000), shares: [share(SHOP_URL, `copy`)] },
    { name: `NPMJS_COM`, title: `npm`, username: `ada`, hosts: [`npmjs.com`], captured: { source: `import`, via: `Chrome`, at: NOW - 60_000 * MIN } },
    { name: `FIGMA_COM`, title: `Figma`, username: `ada@analytical.engine`, hosts: [`figma.com`], captured: { source: `import`, via: `1Password`, at: NOW - 60_000 * MIN }, health: { weak: true, reused: false } },
    { name: `LINEAR_APP`, title: `Linear`, username: `ada`, hosts: [`linear.app`], captured: brave(70_000) },
    { name: `NOTION_SO`, title: `Notion`, username: `ada@analytical.engine`, hosts: [`notion.so`], captured: brave(80_000), health: { weak: false, reused: true } },
    { name: `SLACK_COM`, title: `Slack`, username: `ada@analytical.engine`, hosts: [`slack.com`], captured: brave(81_000), health: { weak: false, reused: true } },
    { name: `CLOUDFLARE_COM`, title: `Cloudflare`, username: `ada@analytical.engine`, hosts: [`dash.cloudflare.com`], captured: brave(90_000), shares: [share(SHOP_URL, `while-here`)] },
    { name: `GOOGLE_COM`, title: `Google`, username: `ada.lovelace@gmail.com`, hosts: [`accounts.google.com`], captured: brave(100_000) },
    { name: `ROUTER_ADMIN`, title: `Home router`, username: `admin`, hosts: [`192.168.1.1`], health: { weak: true, reused: false } },
    { name: `MSTSC_BUILD`, title: `Remote Desktop build-02`, username: `ADA\\builder`, programs: [`mstsc.exe`], captured: { source: `app`, via: `Remote Desktop`, at: NOW - 30_000 * MIN } },
    { name: `KEEPASSXC_DB`, title: `KeePassXC`, programs: [`KeePassXC.exe`] },
    { name: `DOCKER_DESKTOP`, title: `Docker Desktop`, username: `ada`, programs: [`Docker Desktop.exe`] },
    { name: `SUDO_ROOT`, title: `sudo`, askpass: [`sudo`], captured: { source: `askpass`, via: `sudo`, at: NOW - 50_000 * MIN } },
    { name: `GIT_GITHUB_COM`, title: `git github.com`, username: `ada`, askpass: [`git:https://github.com`], hosts: [`github.com`], captured: { source: `git`, via: `git`, at: NOW - 45_000 * MIN }, shares: [share(DEV_URL, `each-use`)] },
    { name: `SSH_DEPLOY_PROD`, title: `ssh deploy@prod-1`, username: `deploy`, askpass: [`ssh:deploy@prod-1`], shares: [share(SHOP_URL, `each-use`)] },
    { name: `SSH_KEY_ID_ED25519`, title: `ssh key id_ed25519`, askpass: [`ssh-key:~/.ssh/id_ed25519`] },
    { name: `FORTICLIENT_PHONE`, title: `FortiClient (phone)`, username: `ada.lovelace`, packages: [`com.fortinet.forticlient`], captured: { source: `phone`, via: `Pixel 8`, at: NOW - 12_000 * MIN } },
    { name: `BANKING_APP`, title: `mBank`, username: `ada`, packages: [`pl.mbank`] },
    { name: `WIFI_OFFICE`, title: `Office Wi-Fi`, kind: `text`, note: `Guest network: analytical-guest.` },
    { name: `LICENSE_KEY`, title: `JetBrains licence`, kind: `text`, note: `Renews in March.` },
];

const entryOf = (sample: Sample, index: number): KeyringEntry => ({
    name: sample.name,
    title: sample.title,
    kind: sample.kind ?? `password`,
    programs: sample.programs ?? [],
    packages: sample.packages ?? [],
    hosts: sample.hosts ?? [],
    anyField: sample.kind === `text`,
    askpass: sample.askpass ?? [],
    source: `keyring`,
    shares: sample.shares ?? [],
    createdAt: NOW - (index + 10) * 86_400_000,
    updatedAt: sample.captured?.at ?? NOW - (index + 10) * 86_400_000,
    username: sample.username,
    note: sample.note,
    captured: sample.captured,
    fresh: sample.fresh === true,
    unverified: sample.unverified === true,
    versions: sample.versions ?? 0,
    health: sample.health,
    lastUsedAt: NOW - (index + 1) * 40 * MIN,
});

let entries: KeyringEntry[] = SAMPLES.map(entryOf);
let needs: KeyringPendingNeed[] = [
    {
        id: `need0000000000000001`,
        sandbox: DEV_URL,
        need: { origin: { kind: `site`, host: `github.com` }, username: `ada`, detail: `push the release branch`, purpose: `agent`, typeOnce: false },
        matches: [`GITHUB_COM`],
        at: NOW - 2 * MIN,
    },
];
const activity: KeyringActivityLine[] = [
    { at: NOW - 40 * MIN, op: `type`, outcome: `granted`, secret: `FORTICLIENT`, sandbox: DEV_URL, program: `FortiClient` },
    { at: NOW - 60 * MIN, op: `askpass`, outcome: `granted`, secret: `SSH_ADA_BUILD_01`, program: `ssh` },
    { at: NOW - 120 * MIN, op: `capture`, outcome: `saved`, secret: `GITHUB_COM`, target: `github.com`, program: `Brave` },
    { at: NOW - 300 * MIN, op: `capture`, outcome: `saved`, secret: `SSH_ADA_BUILD_01`, program: `ssh` },
    { at: NOW - 26 * 60 * MIN, op: `capture`, outcome: `saved`, secret: `FORTICLIENT`, program: `FortiClient` },
    { at: NOW - 3 * 86_400_000, op: `share`, outcome: `done`, secret: `GITHUB_COM`, sandbox: DEV_URL },
    { at: NOW - 4 * 86_400_000, op: `release`, outcome: `refused`, secret: `GITHUB_COM`, sandbox: DEV_URL, asked: true },
];
const SOURCES = (): KeyringSourceStatus[] => [
    { source: `browser`, on: remember.browser, ready: true, available: true, detail: `Brave` },
    { source: `terminal`, on: remember.terminal, ready: remember.terminal, available: true, asks: `Windows asks once` },
    { source: `apps`, on: remember.apps, ready: true, available: true },
    { source: `phone`, on: remember.phone, ready: false, available: false, why: `No phone is paired yet.` },
    { source: `sandbox`, on: remember.sandbox, ready: true, available: true },
];

const ok = <T>(fields?: T): string => JSON.stringify({ ok: true, ...fields });
const refuse = (code: string, refusal: string): string => JSON.stringify({ ok: false, code, refusal });

const statusLine = (): string => {
    if (devMode === `old`) {
        return refuse(`agent-too-old`, `This computer's Intentic agent has no keyring yet. Update the agent, then try again.`);
    }
    const state: KeyringState = {
        version: `1.320.0`,
        locked,
        unlock: [`hello`, `passphrase`],
        keys: { seal: `A`.repeat(43), inbox: `B`.repeat(43) },
        pendingInbox: 0,
        pendingCaptures: locked ? 2 : 0,
        remember,
    };
    if (!locked) {
        state.unlockedUntil = Date.now() + settings.autoLockMinutes * MIN;
    }
    const support = { canSetUp: true, hello: true, platform: `windows` as const };
    const status: KeyringStatus = setUp
        ? { installed: true, running: true, setUp: true, state, askpass: { installed: remember.terminal }, support }
        : { installed: true, running: true, setUp: false, askpass: { installed: false }, support };
    return ok(status);
};

/** The arguments the dev page's own desktop.ts sends with a keyring command, every command's in one shape. */
interface VerbArgs {
    readonly name?: string;
    readonly sandbox?: string;
    readonly mode?: string;
    readonly op?: KeyringAppOp;
    readonly input?: KeyringAppOps[KeyringAppOp][`in`];
}
const argsOf = (args: InvokeArgs | undefined): VerbArgs =>
    // SAFETY: on the dev server every invoke comes from this page's own desktop.ts, which builds these very arguments.
    args === undefined || Array.isArray(args) || args instanceof ArrayBuffer || args instanceof Uint8Array ? {} : (args as VerbArgs);

// A change waits a moment, as the person's yes at the computer would; locked, a value-revealing one is refused.
const prompted = (effect: () => string | undefined): Promise<string> => sleep(1200).then(() => effect() ?? ok());
const unlockedOr = (effect: () => string | undefined): Promise<string> =>
    prompted(() => (locked ? refuse(`locked`, `Passwords is locked. Unlock it, then try again.`) : effect()));

const saveSample = (draft: KeyringAppOps[`save`][`in`]): string => {
    const made = draft.title.toUpperCase().replace(/[^A-Z0-9]+/gu, `_`) || `PASSWORD`;
    const hosts = draft.origins.flatMap((origin) => (origin.kind === `site` ? [origin.host] : []));
    const programs = draft.origins.flatMap((origin) => (origin.kind === `program` ? [origin.program] : []));
    entries = [...entries, entryOf({ name: made, title: draft.title, hosts, programs, captured: { source: `manual`, via: `you`, at: Date.now() } }, 0)];
    return ok({ outcome: `saved`, name: made });
};

const VERSIONS = [
    { version: 2, at: NOW - 9 * 86_400_000 },
    { version: 1, at: NOW - 40 * 86_400_000 },
];

/** Each `keyring app <op>` as the stand-in answers it: one function per op, taking that op's own input. */
type StandInApp = { readonly [Op in KeyringAppOp]: (input: KeyringAppOps[Op][`in`]) => string | Promise<string> };

/** Each `keyring app <op>`, answered from the sample vault. */
const APP: StandInApp = {
    reveal: ({ name }) => unlockedOr(() => ok({ value: `sample-${name.toLowerCase()}-9#Kq`, username: entries.find((entry) => entry.name === name)?.username })),
    copy: () => unlockedOr(() => ok({ clearsAt: Date.now() + 30_000 })),
    history: ({ name }) => ok({ versions: VERSIONS.slice(0, entries.find((entry) => entry.name === name)?.versions ?? 0) }),
    restore: () => prompted(() => undefined),
    undo: () => prompted(() => undefined),
    seen: ({ names }) => {
        entries = entries.map((entry) => (names.includes(entry.name) ? { ...entry, fresh: false } : entry));
        return ok();
    },
    settings: () => ok({ settings }),
    "set-settings": ({ patch }) =>
        prompted(() => {
            remember = { ...remember, ...patch.remember };
            settings = { ...settings, ...patch, remember, rememberAskedAt: Date.now() };
            return ok({ settings });
        }),
    activity: ({ name }) => ok({ lines: name === undefined ? activity : activity.filter((line) => line.secret === name) }),
    needs: () => ok({ pending: needs }),
    "answer-need": ({ id }) =>
        prompted(() => {
            needs = needs.filter((need) => need.id !== id);
            return undefined;
        }),
    save: (draft) => prompted(() => saveSample(draft)),
    edit: ({ name, patch }) =>
        prompted(() => {
            entries = entries.map((entry) => (entry.name === name ? { ...entry, title: patch.title ?? entry.title, username: patch.username ?? entry.username, note: patch.note ?? entry.note, updatedAt: Date.now() } : entry));
            return undefined;
        }),
    import: ({ rows }) => prompted(() => ok({ saved: rows.length, updated: 0, unchanged: 0, skipped: 0 })),
    sources: () => ok({ sources: SOURCES() }),
    "setup-source": () => prompted(() => undefined),
};

const appVerb = <Op extends KeyringAppOp>(op: Op, input: KeyringAppOps[Op][`in`]): string | Promise<string> => APP[op](input);

const shareVerb = (command: string, args: VerbArgs): Promise<string> =>
    prompted(() => {
        const { name, sandbox = ``, mode } = args;
        entries = entries.map((entry) => {
            if (entry.name !== name) {
                return entry;
            }
            const kept = entry.shares.filter((known) => known.sandbox !== sandbox);
            return command === `keyring_unshare` || !(mode === `each-use` || mode === `while-here` || mode === `copy`)
                ? { ...entry, shares: kept }
                : { ...entry, shares: [...kept, { sandbox, machine: `ada-laptop`, mode, sharedAt: Date.now() }] };
        });
        return undefined;
    });

export const keyringVerb = (command: string, args: InvokeArgs | undefined): string | Promise<string> | undefined => {
    switch (command) {
        case `keyring_status`:
            return statusLine();
        case `keyring_list`:
            return ok({ entries: setUp ? entries : [], backends: [] });
        case `keyring_setup`:
            return sleep(2500).then(() => {
                setUp = true;
                locked = false;
                remember = { browser: false, terminal: false, apps: false, phone: false, sandbox: false };
                settings = { remember, neverSave: [], autoLockMinutes: settings.autoLockMinutes, lockOnSleep: settings.lockOnSleep };
                return ok({ setUp: true, alreadySetUp: false, recoveryKey: `K7QX-29MF-H3TB-W8NC-5RVD-J4PL` });
            });
        case `keyring_unlock`:
            return prompted(() => {
                locked = false;
                return undefined;
            });
        case `keyring_lock`:
            locked = true;
            return ok();
        case `keyring_remove`:
            return prompted(() => {
                entries = entries.filter((entry) => entry.name !== argsOf(args).name);
                return undefined;
            });
        case `keyring_share`:
        case `keyring_unshare`:
            return shareVerb(command, argsOf(args));
        case `keyring_app`: {
            const { op, input } = argsOf(args);
            return op === undefined || input === undefined ? refuse(`unknown`, `Passwords asked nothing.`) : appVerb(op, input);
        }
        default:
            return undefined;
    }
};
