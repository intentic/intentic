import type { PanelSummary, RepoApp } from "@intentic-app/api-contract";
import type { PortSummary, PublicFile } from "@intentic/sandbox-contract";

/* EVERYTHING THE WORKSPACE CAN SHOW LIVE, as one flat list the Preview area's switcher renders:
 *   · repo   , a repository's dev server, from the /panels list
 *   · app    , one app inside a monorepo, its own dev server, from the per-repo /apps routes
 *   · port   , a forwarded port, from /ports: the answer for a server nothing here started
 *   · public , the outbox's served page, live with no process at all
 *   · address, whatever the user typed in, because a preview should never be a closed list
 *
 * ONE LIST, TWO READERS, AND THAT IS THE POINT. The rail's tile and the panel are built from the SAME builders
 * (the rail simply skips the per-monorepo apps fan-out, which only ever ADDS rows), so a badge claiming "1
 * running" over a panel saying "nothing to preview" is impossible by construction. It was not before: the tile
 * counted a monorepo as evidence while the panel dropped it, so a monorepo with no `_apps/` instances, the
 * ordinary shape of a repo whose root `dev` runs turbo, showed a badge over an empty screen.
 *
 * PURE ON PURPOSE, contract types in, targets out, no app imports, so these rules are testable without a
 * daemon and the rail can read them without pulling the query chain. usePreviewTargets.ts wires them to the
 * live reads. */

export type PreviewKind = `repo` | `app` | `port` | `public` | `address`;

export interface PreviewTarget {
    // `repo:<repo>` | `app:<repo>/<app>` | `port:<n>` | `public` | `address`, what the switcher stores and a
    // tree row can name.
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
    // The URL the iframe loads; absent while the sandbox has no zone (nothing routable to show).
    readonly url: string | undefined;
    readonly running: boolean;
    readonly healthy: boolean;
    /* The tmux session whose pane shows this target's dev server, the daemon's own when it started it, a
     * user's when they ran it by hand, absent when nothing here owns one (see PanelSummary.servers). The
     * Terminal button appears only when this exists; a button opening an empty panel is worse than none. */
    readonly session: string | undefined;
    // Whether Start/Stop mean anything here, a port, the public page and a typed address have no process
    // this app owns.
    readonly startable: boolean;
}

export const repoTargetId = (repo: string): string => `repo:${repo}`;

/* WHAT THE IFRAME'S `sandbox` ATTRIBUTE SAYS, and it is one decision worth writing down rather than nine
 * characters of markup.
 *
 * `sandbox` WITHOUT `allow-same-origin` GIVES THE FRAMED PAGE AN OPAQUE ORIGIN, it stops being
 * `localhost:4322` and becomes nobody. Every request it then makes leaves as `Origin: null` and is
 * cross-origin to the very server that served it: fonts and modules are refused by CORS, and a dev server
 * answers `/@fs` asset requests with 403 because a stranger is asking. A typed `localhost:4322` therefore
 * rendered its text and none of its images. Nothing was bought by it: what protects this app is that the
 * preview is a DIFFERENT ORIGIN, which a dev server, a forwarded port and somebody else's site all are, so
 * the framed page cannot reach this window's DOM or storage however the attribute reads.
 *
 * The outbox page is the exception, and the exception is about ORIGIN rather than about trust: that HTML is
 * written by an agent and served from the sandbox's own public host, which in a self-hosted deployment can be
 * the host this app is served from, the one case the origin boundary does not cover. It is a single
 * self-contained file by construction, so it has no subresources to lose. */
export const frameSandbox = (kind: PreviewKind): string | undefined => (kind === `public` ? `allow-scripts allow-forms allow-popups` : undefined);

/* Every runnable repository, MONOREPOS INCLUDED. A monorepo's root `dev` fans out across packages, so its
 * repo-level preview host answers for whichever of them bound the assigned port, imprecise, but it is what
 * the daemon actually serves, and the alternative (showing nothing) is what produced the empty screen this
 * list now can't produce. Where a monorepo DOES have `_apps/` instances, `mergeTargets` drops this row in
 * favour of the per-app ones, which are the precise answer. */
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
            /* ONLY WHILE THE DAEMON RUNS IT. `preview-<repo>-…` resolves to the port the process manager
             * assigned this panel, so a repo answering from a dev server somebody started in their own
             * terminal has a hostname that routes to nothing and 502s. `healthy` cannot stand in for that,
             * it means "something this repo owns is answering", terminal-started servers included, so a
             * healthy target with no url is a real state the panel explains (forward its port, or start it
             * from here) rather than an error page in an iframe. */
            url: panel.running ? panel.previewUrl : undefined,
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
        detail: undefined,
        repo,
        app: app.app,
        url: app.previewUrl,
        running: app.running,
        healthy: app.healthy,
        session: app.running ? `panel-${repo}--${app.app}` : undefined,
        startable: true,
    }));

/* FORWARDED PORTS, the answer for a dev server this app never started: an agent's ad-hoc process, a published
 * container port, `pnpm dev` run by hand in a terminal. Forwarding is already the explicit "make this
 * reachable" gesture (Ports view), and a forwarded port answers at a public hostname, so it previews with no
 * further permission. Unforwarded ones are deliberately absent: their loopback address means nothing to this
 * browser, and an iframe pointed at it would show the user's own machine. */
export const portTargets = (ports: readonly PortSummary[]): PreviewTarget[] =>
    ports
        .filter((port) => port.forwarded && port.previewUrl !== undefined)
        .map((port) => ({
            id: `port:${port.port}`,
            kind: `port`,
            label: `Port ${port.port}`,
            // What is answering there, trimmed to the part that identifies it, a full argv is a paragraph.
            detail: port.command?.split(/\s+/u).at(-1)?.split(`/`).at(-1),
            repo: undefined,
            app: undefined,
            url: port.previewUrl,
            // A listening socket IS the running server; there is nothing here to start or stop.
            running: true,
            healthy: true,
            session: port.session,
            startable: false,
        }));

/* The outbox's page, when one is SERVED, read off the listing rather than off anyone's account of it, so a
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
              detail: undefined,
              repo: undefined,
              app: undefined,
              url: page.url,
              running: true,
              healthy: true,
              session: undefined,
              startable: false,
          };
};

export const ADDRESS_TARGET_ID = `address`;

/* WHATEVER THE USER TYPED. Everything above is discovered, and a discovered list is a closed one: the moment
 * somebody wants a staging URL, a second route of their own app, or a page on another box, a preview that can
 * only offer what it found is a preview they have to leave. This row is the escape hatch, kept as one target
 * rather than a list so the bar shows an address FIELD and not a bookmark manager.
 *
 * A bare host is meant as https, nobody types a scheme to visit a site, and anything unparseable yields no
 * target at all rather than an iframe pointed at a guess. */
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
        running: true,
        healthy: true,
        session: undefined,
        startable: false,
    };
};

/* THE WHOLE LIST, in reading order: each repo (its apps in place of its root where it has them), then the
 * forwarded ports, then the workspace's own page, then the typed address. Apps REPLACE their monorepo's root
 * row rather than joining it, two rows for one thing, one of them vague, is worse than either alone. */
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

/* Which target the panel shows, and the whole selection contract:
 *   · an exact id the user picked, while it still exists
 *   · a `repo:<dir>` id whose repo yields only app targets (the tree's door names a monorepo this way) lands
 *     on that repo's first target rather than falling through to somewhere else
 *   · otherwise the best evidence there is: something healthy, else something running, else a dev server that
 *     could be started, else whatever is left
 * Dev servers and ports outrank the static page in every tier, a running app beats a file, and ties keep
 * list order, which is the /panels list's own. */
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

/* THE RAIL'S HALF, from the same builders the panel uses minus the per-monorepo apps fan-out (which only ever
 * replaces rows one-for-one, never empties the list), so the tile can promise nothing the panel cannot show.
 * The typed address is deliberately not counted: it is the user's own bookmark, not evidence about the box. */
export const railTargets = (panels: readonly PanelSummary[], ports: readonly PortSummary[], publicFiles: readonly PublicFile[]): PreviewTarget[] =>
    mergeTargets(repoTargets(panels), [], portTargets(ports), publicTarget(publicFiles), undefined);

export const previewEvidence = (panels: readonly PanelSummary[], ports: readonly PortSummary[], publicFiles: readonly PublicFile[]): boolean =>
    railTargets(panels, ports, publicFiles).length > 0;

// How many previewable things are actually ANSWERING right now, the tile's neutral count.
export const previewHealthyCount = (panels: readonly PanelSummary[], ports: readonly PortSummary[], publicFiles: readonly PublicFile[]): number =>
    railTargets(panels, ports, publicFiles).filter((target) => target.healthy && target.kind !== `public`).length;
