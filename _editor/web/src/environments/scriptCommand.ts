import { ref, watch } from "vue";
import { environment } from "./environment";

/* The connect/sync/host install scripts the copy-paste one-liners run. Two deliveries, chosen by build:
 *   • deploy (production): fetch the public intentic.dev vanity URL, the site worker (see _site/site) serves
 *     the scripts tracked in _site/site/public/scripts/ and redirects each vanity path to the `stable`
 *     release's script. The private repo has no anonymous raw URL, so we never fetch from it directly.
 *   • local dev: the platform runs on the same machine as the checked-out repo, so run the script BY PATH
 *     (relative to the repo root), no network fetch, and the command exercises the working-tree scripts.
 * In dev the choice is the developer's (see scriptSource); a deployed build only ever has the first. */
const SCRIPT_URLS = {
    sh: `https://intentic.dev/connect`,
    ps1: `https://intentic.dev/connect.ps1`,
    hostSh: `https://intentic.dev/connect-host`,
    hostPs1: `https://intentic.dev/connect-host.ps1`,
    cleanupHost: `https://intentic.dev/cleanup-host`,
    desktopSh: `https://intentic.dev/sync`,
    desktopPs1: `https://intentic.dev/sync.ps1`,
    computerSh: `https://intentic.dev/computer`,
    computerPs1: `https://intentic.dev/computer.ps1`,
    rebuild: `https://intentic.dev/rebuild`,
    rebuildPs1: `https://intentic.dev/rebuild.ps1`,
    update: `https://intentic.dev/update`,
    updatePs1: `https://intentic.dev/update.ps1`,
    cleanup: `https://intentic.dev/cleanup`,
    cleanupPs1: `https://intentic.dev/cleanup.ps1`,
} as const;

export const SCRIPT_PATHS = {
    sh: `_site/site/public/scripts/connect.sh`,
    ps1: `_site/site/public/scripts/connect.ps1`,
    hostSh: `_site/site/public/scripts/connect-host.sh`,
    hostPs1: `_site/site/public/scripts/connect-host.ps1`,
    cleanupHost: `_site/site/public/scripts/cleanup-host.sh`,
    desktopSh: `_site/site/public/scripts/sync.sh`,
    desktopPs1: `_site/site/public/scripts/sync.ps1`,
    computerSh: `_site/site/public/scripts/computer.sh`,
    computerPs1: `_site/site/public/scripts/computer.ps1`,
    // One recreate script serves both flows, mode inferred from the argument shape (see recreate.sh), or
    // from named parameters in the PowerShell twin (-Slug, plus -Hash for a rebuild).
    rebuild: `_site/site/public/scripts/recreate.sh`,
    rebuildPs1: `_site/site/public/scripts/recreate.ps1`,
    update: `_site/site/public/scripts/recreate.sh`,
    updatePs1: `_site/site/public/scripts/recreate.ps1`,
    cleanup: `_site/site/public/scripts/cleanup.sh`,
    cleanupPs1: `_site/site/public/scripts/cleanup.ps1`,
} as const;

type ScriptKey = keyof typeof SCRIPT_URLS;

export type ScriptSource = "checkout" | "published";

const SOURCE_KEY = `intentic.script-source`;

const readSource = (): ScriptSource => {
    try {
        return localStorage.getItem(SOURCE_KEY) === `published` ? `published` : `checkout`;
    } catch {
        // Storage may be unavailable (private mode); the working tree is the dev default either way.
        return `checkout`;
    }
};

/* WHICH OF THE TWO DELIVERIES A DEV BUILD HANDS OUT. The path form is the right default, exercising the
 * working-tree scripts is the point of running the platform locally, but the command is regularly pasted
 * somewhere the checkout simply is not: a second computer, a VM, a phone. There the path form cannot run at
 * all, and the released one-liner is the only thing that works, so a dev build has to be able to ask for it.
 *
 * One module-level ref, on the useOsPreference precedent: the choice is about the developer, not about the
 * screen they made it on, so every command block in the tab follows it. Persisted for the same reason a dev
 * makes it once per session rather than once per dialog. Inert in production, which has only one delivery. */
export const scriptSource = ref<ScriptSource>(readSource());

watch(scriptSource, (value) => {
    try {
        localStorage.setItem(SOURCE_KEY, value);
    } catch {
        // Storage may be unavailable; the in-memory ref still holds for this tab.
    }
});

const fetched = (): boolean => environment.production || scriptSource.value === `published`;

// A POSIX-sh one-liner. `prefix` is everything between the pipe and `sh` (e.g. `sudo env FOO='..' `, trailing
// space; empty for a bare `sh`); `args` are positional args (empty when the script reads only env vars). Deploy
// pipes `curl … | sh`; dev runs the sibling script by path. The dev form omits `--`: in `sh -s -- ARGS` the `--`
// ends sh's OWN options (the script still gets ARGS as $1…), but by path there is no `-s`, so `sh PATH ARGS`
// passes ARGS directly, a stray `--` would land in scripts (e.g. rebuild/update) as $1.
export const bashCommand = (key: ScriptKey, prefix: string, args: string): string =>
    fetched()
        ? `curl -fsSL ${SCRIPT_URLS[key]} | ${prefix}sh${args ? ` -s -- ${args}` : ``}`
        : `${prefix}sh ${SCRIPT_PATHS[key]}${args ? ` ${args}` : ``}`;

// A PowerShell one-liner. `env` is the `$env:X='..'; …; ` prefix (trailing space); `args` are the script's own
// PowerShell parameters (e.g. `-Slug abc -Yes`), for scripts that take parameters instead of env vars. Dev calls
// the local script with `&`. Deploy fetches it, as `irm <url> | iex` when there is nothing to pass, else as
// `& ([scriptblock]::Create((irm <url>))) ARGS`, because `iex` on a pipeline has no way to forward parameters to
// the script it runs. Caveat: running `& ./_site/site/public/scripts/*.ps1` can trip PowerShell's ExecutionPolicy
// on Windows dev boxes (both fetched forms bypass it), a local-dev-only wrinkle; loosen the policy or drive the
// .sh variant under WSL.
export const psCommand = (key: ScriptKey, env: string, args = ``): string => {
    if (!fetched()) {
        return `${env}& ./${SCRIPT_PATHS[key]}${args ? ` ${args}` : ``}`;
    }
    return args ? `${env}& ([scriptblock]::Create((irm ${SCRIPT_URLS[key]}))) ${args}` : `${env}irm ${SCRIPT_URLS[key]} | iex`;
};
