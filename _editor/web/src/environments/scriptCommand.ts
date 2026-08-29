import { INSTALL_SCRIPTS, type InstallScript, installScriptPath, installScriptUrl } from "@intentic/constants";
import { ref, watch } from "vue";
import { environment } from "./environment";

/* The connect/sync/host install scripts the copy-paste one-liners run. Two deliveries, chosen by build:
 *   • deploy (production): fetch the public intentic.dev vanity URL, the site worker (see _site/site) serves
 *     the scripts tracked in _site/site/public/scripts/ and redirects each vanity path to the `stable`
 *     release's script. The private repo has no anonymous raw URL, so we never fetch from it directly.
 *   • local dev: the platform runs on the same machine as the checked-out repo, so run the script BY PATH
 *     (relative to the repo root), no network fetch, and the command exercises the working-tree scripts.
 * In dev the choice is the developer's (see scriptSource); a deployed build only ever has the first.
 *
 * BOTH FORMS ARE DERIVED FROM ONE TABLE (@intentic/constants INSTALL_SCRIPTS), which the site worker serves
 * from and the site's own pages link to. The URL this file writes into a command and the route that answers
 * it were previously two hand-synced lists in two packages, where a rename left `curl` piping the site's 404
 * page into `sh`. */
type ScriptKey = InstallScript;

// Kept as a table (rather than folded into the two builders below) for the test that asserts every key names
// a file that is actually in the checkout: an unrunnable dev command is otherwise only found by pasting one.
export const SCRIPT_PATHS = Object.fromEntries(
    Object.keys(INSTALL_SCRIPTS).map((key) => [key, installScriptPath(key as ScriptKey)]),
) as Record<ScriptKey, string>;

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
        ? `curl -fsSL ${installScriptUrl(key)} | ${prefix}sh${args ? ` -s -- ${args}` : ``}`
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
    return args ? `${env}& ([scriptblock]::Create((irm ${installScriptUrl(key)}))) ${args}` : `${env}irm ${installScriptUrl(key)} | iex`;
};
