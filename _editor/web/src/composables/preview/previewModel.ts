import type { PanelSummary, RepoApp } from "@intentic-app/api-contract";
import type { PublicFile } from "@intentic/sandbox-contract";

/* EVERYTHING THE WORKSPACE CAN SHOW LIVE, as one flat list the Preview area's switcher renders. Three kinds,
 * from three reads that already exist:
 *   · repo  — a plain repository's dev server (`hasPanel`), from the /panels list
 *   · app   — one app inside a monorepo, its own dev server, from the per-repo /apps routes
 *   · public — the outbox's served page, live with no process at all
 * A monorepo contributes its APPS and not itself: its root `dev` fans out across packages, so the repo-level
 * preview host answers for no one app in particular — the same reason the Apps view previews per app.
 *
 * PURE ON PURPOSE — contract types in, targets out, no app imports — so the rules that decide what a new user
 * sees first are testable without a daemon, and the rail can read the cheap half (previewEvidence) without
 * pulling the query chain. usePreviewTargets.ts wires these to the live reads. */

export type PreviewKind = `repo` | `app` | `public`;

export interface PreviewTarget {
    // `repo:<repo>` | `app:<repo>/<app>` | `public` — what the switcher stores and a tree row can name.
    readonly id: string;
    readonly kind: PreviewKind;
    // What the switcher row says: the app's name, or the repo's, or "Public site".
    readonly label: string;
    // The owning repo; absent for the public page, which belongs to the workspace rather than a repo.
    readonly repo: string | undefined;
    // The app instance's name, for the per-app start/stop routes; only `app` targets carry one.
    readonly app: string | undefined;
    // The public URL the iframe loads; absent while the sandbox has no zone (nothing routable to show).
    readonly url: string | undefined;
    readonly running: boolean;
    readonly healthy: boolean;
    /* The tmux session whose pane shows this target's dev server — the daemon's own when it started it, a
     * user's when they ran it by hand, absent when nothing here owns one (see PanelSummary.servers). The
     * Terminal button appears only when this exists; a button opening an empty panel is worse than none. */
    readonly session: string | undefined;
    // Whether Start/Stop mean anything here — the public page has no process behind it.
    readonly startable: boolean;
}

export const repoTargetId = (repo: string): string => `repo:${repo}`;

// Plain runnable repos. A monorepo is deliberately absent — its apps below are its previews.
export const repoTargets = (panels: readonly PanelSummary[]): PreviewTarget[] =>
    panels
        .filter((panel) => panel.hasPanel && !panel.monorepo)
        .map((panel) => ({
            id: repoTargetId(panel.repo),
            kind: `repo`,
            label: panel.repo,
            repo: panel.repo,
            app: undefined,
            url: panel.previewUrl,
            running: panel.running,
            healthy: panel.healthy,
            /* The terminal there IS, not the one a Start would make: `panel-<repo>` whenever the daemon runs
             * this panel (after a failed start that pane holds the error and is the only place it exists); a
             * repo answering from a server somebody else started names that server's own session. */
            session: panel.running ? `panel-${panel.repo}` : panel.servers.find((server) => server.session !== undefined)?.session,
            startable: true,
        }));

// One monorepo's apps. The session name is the process manager's own convention (appPanelKey: `<repo>--<app>`).
export const appTargets = (repo: string, apps: readonly RepoApp[]): PreviewTarget[] =>
    apps.map((app) => ({
        id: `app:${repo}/${app.app}`,
        kind: `app`,
        label: app.app,
        repo,
        app: app.app,
        url: app.previewUrl,
        running: app.running,
        healthy: app.healthy,
        session: app.running ? `panel-${repo}--${app.app}` : undefined,
        startable: true,
    }));

/* The outbox's page, when one is SERVED — read off the listing rather than off anyone's account of it, so a
 * blocked file never previews as live. `index.html` wins because it is what the outbox root resolves to; any
 * other served page is accepted behind it. Always running: a static file has no process to be down. */
export const publicTarget = (files: readonly PublicFile[]): PreviewTarget | undefined => {
    const served = files.filter((file) => file.blocked === undefined && file.path.toLowerCase().endsWith(`.html`));
    const page = served.find((file) => file.path.toLowerCase() === `index.html`) ?? served[0];
    return page === undefined
        ? undefined
        : {
              id: `public`,
              kind: `public`,
              label: `Public site`,
              repo: undefined,
              app: undefined,
              url: page.url,
              running: true,
              healthy: true,
              session: undefined,
              startable: false,
          };
};

/* Which target the panel shows, and the whole selection contract:
 *   · an exact id the user picked, while it still exists
 *   · a `repo:<dir>` id whose repo yields only app targets (the tree's door names a monorepo this way) lands
 *     on that repo's first target rather than falling through to somewhere else
 *   · otherwise the best evidence there is: something healthy, else something running, else a dev server that
 *     could be started, else the public page
 * Dev servers outrank the public page in every tier — an app beats a static file — and ties keep list order,
 * which is the /panels list's own. */
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
    const servers = targets.filter((target) => target.kind !== `public`);
    return servers.find((target) => target.healthy) ?? servers.find((target) => target.running) ?? servers[0] ?? targets[0];
};

/* THE RAIL'S CHEAP HALF — whether a Preview tile has anything to stand for, and what its badge counts, read
 * off the always-on /panels and /public reads alone (never the per-repo apps fan-out, which is the mounted
 * panel's own cost). A monorepo counts as evidence without asking for its app list: one with no apps is an
 * empty state the area itself explains. */
export const previewEvidence = (panels: readonly PanelSummary[], publicFiles: readonly PublicFile[]): boolean =>
    panels.some((panel) => panel.hasPanel || panel.monorepo) || publicTarget(publicFiles) !== undefined;

// How many previewable things are actually ANSWERING right now — the tile's neutral count. Per repo rather
// than per app (health is read per repo off the listening sockets), which is the honest resolution out here.
export const previewHealthyCount = (panels: readonly PanelSummary[]): number =>
    panels.filter((panel) => (panel.hasPanel || panel.monorepo) && panel.healthy).length;
