// The verb routes (`/<verb>/<arg>…`): which shell a request wants, its arguments checked against the verb table in
// @intentic/constants, and the static script with those arguments injected. Pure, so it is tested without a Worker
// runtime; worker.ts only fetches the asset and answers.
import { isOneLinerVerb, type OneLinerShell, type OneLinerVerb, ps1ParamsText, type ResolvedOneLiner, resolveOneLiner, shArgsText } from "@intentic/constants";

/** Windows PowerShell 5.1 sends `WindowsPowerShell/5.1`, pwsh sends `PowerShell/7.x`; everything else gets sh. */
export const isPowerShell = (userAgent: string | null): boolean => userAgent !== null && userAgent.includes("PowerShell");

/** A verb route, parsed: the verb, its raw arguments, the shell to serve, and the canonical path it was asked by. */
export interface VerbRequest {
    readonly verb: OneLinerVerb;
    readonly args: readonly string[];
    readonly shell: OneLinerShell;
    // Whether the path named the shell (`.ps1`/`.sh`), so a re-fetch of the script gets the same one.
    readonly forced: boolean;
}

/**
 * Reads a path as a verb route, or undefined when its first segment is no verb (the caller routes it as before). A
 * trailing `.ps1` or `.sh` on the last segment picks the shell; otherwise the User-Agent does.
 */
export const parseVerbRoute = (pathname: string, userAgent: string | null): VerbRequest | undefined => {
    const segments = pathname.split("/").filter((segment) => segment !== "");
    const last = segments.at(-1);
    if (last === undefined) {
        return undefined;
    }
    const forced = /\.(ps1|sh)$/u.exec(last);
    if (forced !== null) {
        segments[segments.length - 1] = last.slice(0, -forced[0].length);
    }
    const [verb, ...args] = segments;
    if (verb === undefined || !isOneLinerVerb(verb)) {
        return undefined;
    }
    const shell: OneLinerShell = forced !== null ? (forced[1] as OneLinerShell) : isPowerShell(userAgent) ? "ps1" : "sh";
    return { verb, args, shell, forced: forced !== null };
};

/**
 * A refused one-liner, said where the person will read it. `curl -fsSL … | sh` swallows a 400 (`-f` drops the body and
 * an empty `sh` exits 0), and Windows PowerShell 5.1's `irm` shows only "(400) Bad Request", so a shell asking gets a
 * script that prints the sentence and fails instead. Undefined for a browser, which reads the plain 400 as it is.
 */
export const refusalScript = (shell: OneLinerShell, error: string, userAgent: string | null): string | undefined => {
    const fix = "copy the command again from intentic: this one was changed on the way.";
    const quoted = (text: string): string => `'${text.replaceAll("'", shell === "ps1" ? "''" : `'\\''`)}'`;
    if (shell === "ps1" && isPowerShell(userAgent)) {
        // No `exit`: under `irm | iex` it would close the person's window. The code rides out as the kit's scripts do.
        return `[Console]::Error.WriteLine(${quoted(`error: ${error}`)}); [Console]::Error.WriteLine(${quoted(`   fix:     ${fix}`)}); $global:LASTEXITCODE = 2\n`;
    }
    if (shell === "sh" && userAgent !== null && !userAgent.includes("Mozilla/")) {
        return `#!/bin/sh\nprintf '%s\\n' ${quoted(`error: ${error}`)} ${quoted(`   fix:     ${fix}`)} >&2\nexit 2\n`;
    }
    return undefined;
};

/** The arguments checked against the verb table, or the one sentence the 400 says. */
export const resolveVerbRequest = (request: VerbRequest): ResolvedOneLiner | { readonly error: string } => resolveOneLiner(request.verb, request.args);

const SHEBANG = /^#!.*(?:\r?\n|$)/u;

/**
 * sh: directly after the shebang (else at the very top), `set -- <args>`, `INTENTIC_SCRIPT_URL='<url>'`, then the
 * verb's env lines. So `$1…` are the args exactly as if typed `sh -s -- <args>`. A verb that takes what the person
 * typed (`typed`) gets `set -- <args> "$@"`, so `| sh -s -- --dry-run` still reaches the script.
 */
export const injectSh = (script: string, resolved: ResolvedOneLiner, scriptUrl: string): string => {
    if (scriptUrl.includes("'")) {
        throw new Error("The script URL cannot be single-quoted.");
    }
    const lines = [
        ["set --", shArgsText(resolved.shArgs), resolved.typed ? `"$@"` : ""].filter((part) => part !== "").join(" "),
        `INTENTIC_SCRIPT_URL='${scriptUrl}'`,
        ...resolved.shEnv.map(([name, value]) => `${name}='${value}'; export ${name}`),
    ].join("\n");
    const body = script.replace(/^\uFEFF/u, "");
    const shebang = SHEBANG.exec(body);
    if (shebang === null) {
        return `${lines}\n${body}`;
    }
    const head = shebang[0].endsWith("\n") ? shebang[0] : `${shebang[0]}\n`;
    return `${head}${lines}\n${body.slice(shebang[0].length)}`;
};

/**
 * ps1: `& {` + newline + script + newline + `} <params>`. The script's `param(...)` stays the first statement inside
 * the block and binds the parameters; `$PSCommandPath` is empty there, as under `irm | iex`. A `typed` verb adds
 * `@args`: empty under `irm | iex`, and what the person typed after `& ([scriptblock]::Create((irm …)))`, switches
 * included, since splatting `$args` keeps a `-Name` a parameter name.
 */
export const injectPs1 = (script: string, resolved: ResolvedOneLiner): string => {
    const params = [ps1ParamsText(resolved.ps1Params), resolved.typed ? "@args" : ""].filter((part) => part !== "").join(" ");
    return `& {\n${script.replace(/^\uFEFF/u, "")}\n}${params === "" ? "" : ` ${params}`}\n`;
};

/**
 * The URL the script re-fetches itself from (e.g. under sudo): https, the verb and its checked arguments, never the
 * query string. Call it only once the arguments resolved, so every part is from the safe set.
 */
export const scriptUrlOf = (host: string, request: VerbRequest): string =>
    `https://${host}/${[request.verb, ...request.args].join("/")}${request.forced ? `.${request.shell}` : ""}`;
