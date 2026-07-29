import { environment } from "./environment";

/* The connect/sync/host install scripts the copy-paste one-liners run. Two deliveries, chosen by build:
 *   • deploy (production): fetch the public intentic.dev vanity URL — the site worker (see _apps/site) serves
 *     the scripts tracked in _apps/site/public/scripts/ and redirects each vanity path to the `stable`
 *     release's script. The private repo has no anonymous raw URL, so we never fetch from GitLab.
 *   • local dev: the platform runs on the same machine as the checked-out repo, so run the script BY PATH
 *     (relative to the repo root) — no network fetch, and the command exercises the working-tree scripts. */
const SCRIPT_URLS = {
    sh: `https://intentic.dev/connect`,
    ps1: `https://intentic.dev/connect.ps1`,
    hostSh: `https://intentic.dev/connect-host`,
    hostPs1: `https://intentic.dev/connect-host.ps1`,
    cleanupHost: `https://intentic.dev/cleanup-host`,
    desktopSh: `https://intentic.dev/sync`,
    desktopPs1: `https://intentic.dev/sync.ps1`,
    rebuild: `https://intentic.dev/rebuild`,
    update: `https://intentic.dev/update`,
    cleanup: `https://intentic.dev/cleanup`,
} as const;

export const SCRIPT_PATHS = {
    sh: `_apps/site/public/scripts/connect.sh`,
    ps1: `_apps/site/public/scripts/connect.ps1`,
    hostSh: `_apps/site/public/scripts/connect-host.sh`,
    hostPs1: `_apps/site/public/scripts/connect-host.ps1`,
    cleanupHost: `_apps/site/public/scripts/cleanup-host.sh`,
    desktopSh: `_apps/site/public/scripts/sync.sh`,
    desktopPs1: `_apps/site/public/scripts/sync.ps1`,
    // One recreate script serves both flows — mode inferred from the argument shape (see recreate.sh).
    rebuild: `_apps/site/public/scripts/recreate.sh`,
    update: `_apps/site/public/scripts/recreate.sh`,
    cleanup: `_apps/site/public/scripts/cleanup.sh`,
} as const;

type ScriptKey = keyof typeof SCRIPT_URLS;

// A POSIX-sh one-liner. `prefix` is everything between the pipe and `sh` (e.g. `sudo env FOO='..' `, trailing
// space; empty for a bare `sh`); `args` are positional args (empty when the script reads only env vars). Deploy
// pipes `curl … | sh`; dev runs the sibling script by path. The dev form omits `--`: in `sh -s -- ARGS` the `--`
// ends sh's OWN options (the script still gets ARGS as $1…), but by path there is no `-s`, so `sh PATH ARGS`
// passes ARGS directly — a stray `--` would land in scripts (e.g. rebuild/update) as $1.
export const bashCommand = (key: ScriptKey, prefix: string, args: string): string =>
    environment.production
        ? `curl -fsSL ${SCRIPT_URLS[key]} | ${prefix}sh${args ? ` -s -- ${args}` : ``}`
        : `${prefix}sh ${SCRIPT_PATHS[key]}${args ? ` ${args}` : ``}`;

// A PowerShell one-liner. `env` is the `$env:X='..'; …; ` prefix (trailing space); inputs ride env, so there
// are no positional args. Deploy does `irm <url> | iex`; dev calls the local script with `&`. Caveat: running
// `& ./_apps/site/public/scripts/*.ps1` can trip PowerShell's ExecutionPolicy on Windows dev boxes (the
// `irm | iex` form bypassed it) — a local-dev-only wrinkle; loosen the policy or drive the .sh variant under WSL.
export const psCommand = (key: ScriptKey, env: string): string =>
    environment.production ? `${env}irm ${SCRIPT_URLS[key]} | iex` : `${env}& ./${SCRIPT_PATHS[key]}`;
