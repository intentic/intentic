import { INSTALL_SCRIPTS, type InstallScript, installScriptPath, installScriptUrl } from "@intentic/constants";
import { ref, watch } from "vue";
import { environment } from "./environment";

// Connect/sync/host install scripts behind the copy-paste one-liners. Deploy fetches the public intentic.dev
// vanity URL (site worker); dev runs the script by path against the working tree, no network — chosen by the
// developer (scriptSource) in dev, fixed to fetch in a deployed build. Both forms derive from one table
// (@intentic/constants INSTALL_SCRIPTS) so the URL and the route it resolves to cannot drift apart.
type ScriptKey = InstallScript;

// Kept as a table, not folded into the builders below, so a test can assert every key names a file that actually
// exists in the checkout.
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

// Which delivery a dev build hands out: the path form exercises the working tree, but the command is often pasted
// somewhere the checkout isn't (a VM, a second machine), where only the fetched one-liner runs. One module-level,
// persisted ref (like useOsPreference) since the choice is about the developer, not the screen; inert in
// production, which has only one delivery.
export const scriptSource = ref<ScriptSource>(readSource());

watch(scriptSource, (value) => {
    try {
        localStorage.setItem(SOURCE_KEY, value);
    } catch {
        // Storage may be unavailable; the in-memory ref still holds for this tab.
    }
});

const fetched = (): boolean => environment.production || scriptSource.value === `published`;

// `prefix` is everything between the pipe and `sh` (e.g. `sudo env FOO='..' `); `args` are positional. The path
// form omits `--`: without `-s`, `sh PATH ARGS` passes ARGS directly, so a stray `--` would land in the script as
// $1.
export const bashCommand = (key: ScriptKey, prefix: string, args: string): string =>
    fetched()
        ? `curl -fsSL ${installScriptUrl(key)} | ${prefix}sh${args ? ` -s -- ${args}` : ``}`
        : `${prefix}sh ${SCRIPT_PATHS[key]}${args ? ` ${args}` : ``}`;

// `env` is the `$env:X='..'; ` prefix; `args` are the script's own PowerShell parameters. Fetched form differs when
// args are given: `iex` on a pipeline can't forward parameters, so that case wraps the script in
// `[scriptblock]::Create` instead. Running the local .ps1 directly can trip Windows' ExecutionPolicy; loosen it or
// use the .sh variant under WSL.
export const psCommand = (key: ScriptKey, env: string, args = ``): string => {
    if (!fetched()) {
        return `${env}& ./${SCRIPT_PATHS[key]}${args ? ` ${args}` : ``}`;
    }
    return args ? `${env}& ([scriptblock]::Create((irm ${installScriptUrl(key)}))) ${args}` : `${env}irm ${installScriptUrl(key)} | iex`;
};
