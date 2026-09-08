import type { PanelSummary, RepoApp, PanelLaunch } from "@intentic/api-contract";
import type { PortSummary, PublicFile } from "@intentic/sandbox-contract";

// Everything the workspace can show live, as one flat list both the rail tile and the panel build from (so a count can
// never disagree with what the panel shows). Pure: contract types in, targets out, no app imports.
// - repo: a repository's dev server, from /panels
// - app: one app inside a monorepo, from the per-repo /apps routes
// - port: a forwarded port, from /ports
// - public: the outbox's served page, no process
// - address: whatever the user typed

export type PreviewKind = `repo` | `app` | `port` | `public` | `address`;

export interface PreviewTarget {
    // `repo:<repo>` | `app:<repo>/<app>` | `port:<n>` | `public` | `address`; what the switcher stores.
    readonly id: string;
    readonly kind: PreviewKind;
    // What the switcher row says: the app's name, the repo's, the port, or "Public site".
    readonly label: string;
    // A quiet second line where the label alone is not enough to tell two rows apart (a port's command).
    readonly detail: string | undefined;
    // The owning repo; absent for anything that belongs to the workspace rather than to a repo.
    readonly repo: string | undefined;
    // The app instance's name, for the per-app start/stop routes; only `app` targets carry one.
    readonly app: string | undefined;
    // URL to show, only while real; absent means a state to explain, not a spinner (also absent with no zone).
    readonly url: string | undefined;
    // What one URL can't say: each port of a fanned-out monorepo dev run, forwardable into its own target.
    readonly servers: readonly { readonly port: number; readonly url: string; readonly dir: string | undefined }[];
    readonly running: boolean;
    readonly healthy: boolean;
    // tmux session for this target's dev server, daemon's or a user's; Terminal shows only when set.
    readonly session: string | undefined;
    // Whether Start/Stop apply; a port, the public page, and a typed address own no process.
    readonly startable: boolean;
    // What Start costs (installed) and a running target's progress (launch); undefined/true where nothing starts.
    readonly installed: boolean;
    readonly launch: PanelLaunch | undefined;
}

export const repoTargetId = (repo: string): string => `repo:${repo}`;

// Sandboxes the outbox page (agent-authored HTML on the sandbox's own origin) since it's the one preview that isn't
// already cross-origin; other previews need no sandbox, and adding one there breaks same-origin asset requests.
export const frameSandbox = (kind: PreviewKind): string | undefined => (kind === `public` ? `allow-scripts allow-forms allow-popups` : undefined);

// Every runnable repository, monorepos included; a monorepo's row lists its servers instead of pretending to one
// address. mergeTargets drops this row in favor of per-app ones where `_apps/` exist.
export const repoTargets = (panels: readonly PanelSummary[]): PreviewTarget[] =>
    panels
        .filter((panel) => panel.hasPanel || panel.monorepo)
        .map((panel) => ({
            id: repoTargetId(panel.repo),
            kind: `repo`,
            label: panel.repo,
            detail: undefined,
            repo: panel.repo,
            app: undefined,
            // Absent-with-servers means ports no hostname covers; absent-while-running means still starting.
            url: panel.previewUrl,
            servers: panel.servers.map((server) => ({ port: server.port, url: server.url, dir: server.dir })),
            running: panel.running,
            healthy: panel.healthy,
            // panel-<repo> whenever the daemon runs it; otherwise names whichever server's own session is answering.
            session: panel.running ? `panel-${panel.repo}` : panel.servers.find((server) => server.session !== undefined)?.session,
            // True only where a dev server exists; a monorepo with no root `dev` and no panel stays listed, refused.
            startable: panel.hasPanel,
            installed: panel.installed,
            launch: panel.launch,
        }));

// One app instance's target id; the shell also builds one directly to open a fresh sandbox's starter app.
export const appTargetId = (repo: string, app: string): string => `app:${repo}/${app}`;

// One monorepo's apps. The session name is the process manager's own convention (appPanelKey: `<repo>--<app>`).
export const appTargets = (repo: string, apps: readonly RepoApp[]): PreviewTarget[] =>
    apps.map((app) => ({
        id: appTargetId(repo, app.app),
        kind: `app`,
        label: app.app,
        detail: undefined,
        repo,
        app: app.app,
        url: app.previewUrl,
        // One app instance is one dev server on the port the daemon assigned it: never the ambiguous shape.
        servers: [],
        running: app.running,
        healthy: app.healthy,
        session: app.running ? `panel-${repo}--${app.app}` : undefined,
        startable: true,
        installed: app.installed,
        launch: app.launch,
    }));

// One forwarded port's target id; the panel also forwards ports itself and needs to name what it made.
export const portTargetId = (port: number): string => `port:${port}`;

// Forwarded ports: the answer for a dev server this app never started. Only forwarded ones qualify; an unforwarded
// port's loopback address means nothing to this browser.
export const portTargets = (ports: readonly PortSummary[]): PreviewTarget[] =>
    ports
        .filter((port) => port.forwarded && port.previewUrl !== undefined)
        .map((port) => ({
            id: portTargetId(port.port),
            kind: `port`,
            label: `Port ${port.port}`,
            // What's answering there, in the daemon's own words (ports/port-identity.ts).
            detail: port.title,
            repo: undefined,
            app: undefined,
            url: port.previewUrl,
            servers: [],
            // A listening socket is the running server; nothing here to start or stop.
            running: true,
            healthy: true,
            session: port.session,
            startable: false,
            installed: true,
            launch: undefined,
        }));

// Outbox's served page, read off the listing so a blocked file never previews as live. `index.html` wins (what the
// outbox root resolves to); always running, since a static file has no process to be down.
export const publicTarget = (files: readonly PublicFile[]): PreviewTarget | undefined => {
    const served = files.filter((file) => file.blocked === undefined && file.path.toLowerCase().endsWith(`.html`));
    const page = served.find((file) => file.path.toLowerCase() === `index.html`) ?? served[0];
    return page === undefined
        ? undefined
        : {
              id: `public`,
              kind: `public`,
              label: `Public site`,
              detail: undefined,
              repo: undefined,
              app: undefined,
              url: page.url,
              servers: [],
              running: true,
              healthy: true,
              session: undefined,
              startable: false,
              installed: true,
              launch: undefined,
          };
};

export const ADDRESS_TARGET_ID = `address`;

// Escape hatch for a URL nothing here discovered: a staging URL, another route, another box. A bare host is treated as
// https; anything unparseable yields no target rather than a guess.
export const addressTarget = (typed: string | undefined): PreviewTarget | undefined => {
    const trimmed = typed?.trim() ?? ``;
    if (trimmed === ``) {
        return undefined;
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return undefined;
    }
    if (url.protocol !== `http:` && url.protocol !== `https:`) {
        return undefined;
    }
    return {
        id: ADDRESS_TARGET_ID,
        kind: `address`,
        label: url.host,
        detail: url.pathname === `/` ? undefined : url.pathname,
        repo: undefined,
        app: undefined,
        url: url.toString(),
        servers: [],
        running: true,
        healthy: true,
        session: undefined,
        startable: false,
        installed: true,
        launch: undefined,
    };
};

// Whole list in reading order: repos (apps replacing their monorepo's root row), ports, outbox page, typed address.
export const mergeTargets = (
    repos: readonly PreviewTarget[],
    apps: readonly PreviewTarget[],
    ports: readonly PreviewTarget[],
    outbox: PreviewTarget | undefined,
    address: PreviewTarget | undefined,
): PreviewTarget[] => {
    const detailed = new Set(apps.flatMap((app) => (app.repo === undefined ? [] : [app.repo])));
    const perRepo = repos.flatMap((repo) => {
        if (repo.repo === undefined || !detailed.has(repo.repo)) {
            return [repo];
        }
        return apps.filter((app) => app.repo === repo.repo);
    });
    return [...perRepo, ...ports, ...(outbox === undefined ? [] : [outbox]), ...(address === undefined ? [] : [address])];
};

// Which target the panel shows:
// - an exact id the user picked, if it still exists
// - a `repo:<dir>` id whose repo has only app targets lands on that repo's first target
// - otherwise the best evidence: healthy, else running, else startable, else whatever's left, ties in list order
export const pickTarget = (targets: readonly PreviewTarget[], selectedId: string | undefined): PreviewTarget | undefined => {
    const exact = targets.find((target) => target.id === selectedId);
    if (exact !== undefined) {
        return exact;
    }
    if (selectedId?.startsWith(`repo:`) === true) {
        const repo = selectedId.slice(`repo:`.length);
        const ofRepo = targets.find((target) => target.repo === repo);
        if (ofRepo !== undefined) {
            return ofRepo;
        }
    }
    const servers = targets.filter((target) => target.kind !== `public` && target.kind !== `address`);
    return servers.find((target) => target.healthy) ?? servers.find((target) => target.running) ?? servers[0] ?? targets[0];
};

// Rail's half: same builders as the panel, minus the apps fan-out, so the tile never promises what the panel can't
// show. Typed address doesn't count; it's a bookmark, not evidence.
export const railTargets = (panels: readonly PanelSummary[], ports: readonly PortSummary[], publicFiles: readonly PublicFile[]): PreviewTarget[] =>
    mergeTargets(repoTargets(panels), [], portTargets(ports), publicTarget(publicFiles), undefined);

export const previewEvidence = (panels: readonly PanelSummary[], ports: readonly PortSummary[], publicFiles: readonly PublicFile[]): boolean =>
    railTargets(panels, ports, publicFiles).length > 0;

// How many previewable things are actually answering right now; the tile's neutral count.
export const previewHealthyCount = (panels: readonly PanelSummary[], ports: readonly PortSummary[], publicFiles: readonly PublicFile[]): number =>
    railTargets(panels, ports, publicFiles).filter((target) => target.healthy && target.kind !== `public`).length;
