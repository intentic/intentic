import { refuse } from "@intentic/contract-serve";
import type { RepoApp } from "@intentic/sandbox-contract/schemas/workspace/workspace-repos";
import { workspaceEntries } from "../../fixture/workspace";
import { APP_TEMPLATES, appFiles, type AppTemplate } from "./monorepo";
import { noteWritten } from "./edits";
import { type JobLine, jobAge, jobRunning, startJob, stopJob } from "./jobs";
import { monorepoOf } from "./repos";
import { appPage } from "./appPage";
import { readManifest } from "./manifests";
import { pushRuntime } from "./workspaceBroadcast";

// A monorepo's apps as the daemon runs them: found by their `_apps/<app>/package.json`, each started as its own dev
// server in a terminal (`panel-<repo>--<app>`), installing the workspace first when it never was, and reported running
// as soon as it starts, healthy once its port answers. Adding apps and running tests are one-shot terminals of the
// same kind, whose last line is what ends them.

const DIM = `\u001b[2m`;
const GREEN = `\u001b[32m`;
const CYAN = `\u001b[36m`;
const BOLD = `\u001b[1m`;
const RESET = `\u001b[0m`;
const prompt = (repo: string): string => `${DIM}ada@acme-shop${RESET}:${CYAN}/work/${repo}${RESET}$ `;

// Repos whose node_modules exist: a start after the first takes seconds, the first installs.
const INSTALLED = new Set<string>();

/** The apps under `<repo>/_apps/`, by folder name, each with the template or framework its manifest names. */
const discoverApps = (repo: string): { app: string; kind?: string }[] => {
    const apps = new Map<string, string | undefined>();
    for (const path of workspaceEntries().keys()) {
        const match = new RegExp(`^${repo}/_apps/([a-z][a-z0-9-]*)/package\\.json$`, `u`).exec(path);
        const app = match?.[1];
        if (app !== undefined) {
            const manifest = readManifest(path);
            const deps = Object.keys(manifest?.dependencies ?? {});
            apps.set(app, manifest?.intentic?.template ?? [`astro`, `hono`, `react`].find((framework) => deps.includes(framework)));
        }
    }
    return [...apps].toSorted(([left], [right]) => left.localeCompare(right)).map(([app, kind]) => (kind === undefined ? { app } : { app, kind }));
};

const sessionOf = (repo: string, app: string): string => `panel-${repo}--${app}`;

// How long an install takes before the dev command starts, and the dev server after that before its port answers.
const INSTALL_MS = 3_200;
const BOOT_MS = 1_600;

const devLines = (repo: string, app: string, port: number, install: boolean): JobLine[] => [
    { after: 80, text: prompt(repo) },
    ...(install
        ? [
              { after: 300, text: `pnpm install\r\n` },
              { after: 900, text: `Scope: all 7 workspace projects\r\nLockfile is up to date, resolution step is skipped\r\n` },
              { after: 1_100, text: `Packages: +412\r\n${GREEN}++++++++++++++++++++++++++++++++++++++++${RESET}\r\n` },
              { after: 900, text: `Progress: resolved 412, reused 398, downloaded 14, added 412, done\r\n${DIM}Done in 2.9s${RESET}\r\n` },
          ]
        : []),
    { after: 200, text: `${install ? prompt(repo) : ``}pnpm -C _apps/${app} dev\r\n\r\n` },
    { after: 600, text: `${DIM}> @${repo}/${app}@0.1.0 dev /work/${repo}/_apps/${app}${RESET}\r\n\r\n` },
    { after: 800, text: `  ${GREEN}${BOLD}VITE${RESET} v8.0.2  ${DIM}ready in 412 ms${RESET}\r\n\r\n` },
    { after: 60, text: `  ${GREEN}➜${RESET}  ${BOLD}Local${RESET}:   ${CYAN}http://localhost:${port}/${RESET}\r\n` },
    { after: 60, text: `  ${GREEN}➜${RESET}  ${DIM}press h + enter to show help${RESET}\r\n` },
    { after: 4_000, text: `${CYAN}[vite]${RESET} page reload ${DIM}src/App.tsx${RESET}\r\n` },
];

const portOf = (repo: string, app: string): number => 5_173 + discoverApps(repo).findIndex((entry) => entry.app === app);

// Where a start has got to, the daemon's `launch`: installing, then the dev command with nothing listening yet.
const launchOf = (age: number, installing: boolean): RepoApp[`launch`] => {
    if (installing && age < INSTALL_MS) {
        return `installing`;
    }
    return age < (installing ? INSTALL_MS : 0) + BOOT_MS ? `starting` : undefined;
};

// Starts that had to install first, so their launch phase counts the install.
const INSTALLING = new Set<string>();

/** GET /workspace/repos/{repo}/apps */
export const appsList = (repo: string) => {
    monorepoOf(repo);
    return {
        apps: discoverApps(repo).map(({ app, kind }) => {
            const session = sessionOf(repo, app);
            const age = jobAge(session);
            const launch = age === undefined ? undefined : launchOf(age, INSTALLING.has(session));
            const healthy = age !== undefined && launch === undefined;
            const row: RepoApp = { app, running: age !== undefined, healthy, installed: INSTALLED.has(repo), previewUrl: appPage(repo, app) };
            if (kind !== undefined) {
                row.kind = kind;
            }
            if (launch !== undefined) {
                row.launch = launch;
            }
            return row;
        }),
    };
};

/** POST /workspace/repos/{repo}/apps/{app}/start */
export const startApp = (repo: string, app: string): void => {
    monorepoOf(repo);
    if (!discoverApps(repo).some((entry) => entry.app === app)) {
        refuse(`no app "${app}" in ${repo}`, 404);
    }
    const session = sessionOf(repo, app);
    if (jobRunning(session)) {
        return;
    }
    const install = !INSTALLED.has(repo);
    if (install) {
        INSTALLING.add(session);
        setTimeout(() => {
            INSTALLED.add(repo);
            pushRuntime(`panels`);
        }, INSTALL_MS);
    } else {
        INSTALLING.delete(session);
    }
    startJob(session, { label: `${repo} · ${app}`, kind: `panel`, lines: devLines(repo, app, portOf(repo, app), install), oneShot: false });
    // The port sampler's push once the server binds, which is what flips the row to healthy.
    setTimeout(() => pushRuntime(`panels`, `ports`), (install ? INSTALL_MS : 0) + BOOT_MS + 50);
    pushRuntime(`panels`);
};

/** POST /workspace/repos/{repo}/apps/{app}/stop */
export const stopApp = (repo: string, app: string): void => {
    monorepoOf(repo);
    stopJob(sessionOf(repo, app));
    pushRuntime(`panels`, `ports`);
};

/** The app a preview host names, and whether its dev server answers yet, for the preview proxy (previewSites.ts). */
export const appAt = (host: string): { readonly repo: string; readonly app: string; readonly serving: boolean } | undefined => {
    for (const path of workspaceEntries().keys()) {
        const [, repo, app] = /^([^/]+)\/_apps\/([a-z][a-z0-9-]*)\/package\.json$/u.exec(path) ?? [];
        if (repo !== undefined && app !== undefined && new URL(appPage(repo, app)).host === host) {
            const session = sessionOf(repo, app);
            const age = jobAge(session);
            return { repo, app, serving: age !== undefined && launchOf(age, INSTALLING.has(session)) === undefined };
        }
    }
    return undefined;
};

export const templates = () => ({
    templates: APP_TEMPLATES.map((template) => ({ ...template })),
});

const isTemplate = (key: string): key is AppTemplate => APP_TEMPLATES.some((template) => template.key === key);

/** POST /workspace/repos/{repo}/apps: `intentic scaffold add-app` as a one-shot terminal; the files land as it ends. */
export const addApps = (repo: string, apps: readonly { template: string; name: string }[]): void => {
    monorepoOf(repo);
    const session = sessionOf(repo, `add_apps`);
    if (jobRunning(session)) {
        return;
    }
    for (const { template } of apps) {
        if (!isTemplate(template)) {
            refuse(`no template "${template}" in the source repo`, 400);
        }
    }
    const lines: JobLine[] = [
        { after: 80, text: `${prompt(repo)}intentic scaffold add-app --dir /work/${repo} --apps ${apps.map((app) => `${app.template}:${app.name}`).join(`,`)}\r\n` },
        { after: 700, text: `Fetching templates from acme/shop-templates@main\r\n` },
        ...apps.flatMap(({ template, name }) => [
            { after: 900, text: `  ${GREEN}+${RESET} _apps/${name} ${DIM}(${template})${RESET}\r\n` },
            { after: 300, text: `    package.json, src/, a first test\r\n` },
        ]),
        { after: 900, text: `Linking the workspace: ${GREEN}done${RESET}\r\n` },
        { after: 400, text: `${GREEN}✓${RESET} Added ${apps.length} app${apps.length === 1 ? `` : `s`}. Start ${apps.length === 1 ? `it` : `them`} from the Apps view.\r\n${prompt(repo)}` },
    ];
    startJob(session, {
        label: `${repo} · add apps`,
        kind: `job`,
        lines,
        oneShot: true,
        done: () => {
            const files = apps.flatMap(({ template, name }) => (isTemplate(template) ? appFiles(repo, template, name) : []));
            for (const [path, body] of files) {
                workspaceEntries().set(path, body);
            }
            noteWritten(files.map(([path]) => path));
        },
    });
};
