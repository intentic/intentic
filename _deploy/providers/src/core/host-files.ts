import { envLine, shellQuote } from "@intentic/sandbox-run/quote";
import type { SshSession } from "./ssh.js";

/* WRITING A COMPOSE STACK'S FILES ONTO A HOST, ONCE, for both provider skeletons that do it: the singleton
 * catalog services (compose-service.ts) and the per-instance backings (backing-provider.ts).
 *
 * Every provider that deploys a stack wrote this same pair of steps by hand, `cat > file <<'EOF'` for the
 * config and a `test -f` guarded `.env` for the secrets, and the copies disagreed on all three things that
 * decide whether the stack comes up:
 *
 * QUOTING. The .env line and the host shell escape different characters, and each layer needs the value
 * unmangled by the other: envLine picks a delimiter the value does not contain, shellQuote carries the whole
 * rendered line to the host as one argv word. Copies that quoted only one layer stored a secret that was not
 * the one the resolver generated, silently, for values containing an apostrophe or a `$`.
 *
 * FAILURE. A `cat >` that fails (permission on /opt/intentic, a full disk) left the stack unbootable and said
 * nothing; the error surfaced one step later as compose's "compose.yaml: no such file", which names the wrong
 * thing entirely. Every write here is checked at its origin.
 *
 * WRITE-ONCE VS REWRITTEN. Config files are rewritten on every apply, that is how an image-pin bump reaches
 * the host. The .env is written ONCE and never again: its secrets are baked into the data on first init (a
 * Postgres superuser password, a JWT signing key), so re-keying it locks the deployment out of its own state.
 */

// One line of the write-once .env: a literal `value`, or omitted to have the host generate a
// `openssl rand -hex 32` for it, so a secret nobody needs to see never passes through this process at all.
export interface EnvEntry {
    readonly key: string;
    readonly value?: string;
}

// A config file's content, and whether it carries a secret (chmod 600 after the write). A plain string is
// the same thing with no secret in it, which is most of them.
export interface HostFile {
    readonly content: string;
    readonly secret?: boolean;
}

const exec = async (session: SshSession, kind: string, command: string, what: string): Promise<void> => {
    const result = await session.exec(command);
    if (result.code !== 0) {
        throw new Error(`${kind}: ${what} failed (exit ${result.code}): ${result.stderr.trim()}`);
    }
};

/* The state dir and its config files, rewritten every apply. The heredoc is quoted (`<<'MARKER'`) so the host
 * shell expands nothing inside it: these files are full of `$VARIABLE` references that compose, not the shell,
 * is meant to resolve. */
export const writeHostFiles = async (
    session: SshSession,
    kind: string,
    dir: string,
    files: Readonly<Record<string, string | HostFile>>,
): Promise<void> => {
    await exec(session, kind, `mkdir -p ${dir}`, `create ${dir}`);
    const marker = `${kind.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}_FILE_EOF`;
    for (const [name, file] of Object.entries(files)) {
        const content = typeof file === "string" ? file : file.content;
        // oxlint-disable-next-line eslint/no-await-in-loop -- one session, one shell: the writes are sequential by construction
        await exec(session, kind, `cat > ${dir}/${name} <<'${marker}'\n${content}${marker}`, `write ${dir}/${name}`);
        if (typeof file !== "string" && file.secret === true) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- must land before the next file's write
            await exec(session, kind, `chmod 600 ${dir}/${name}`, `chmod ${dir}/${name}`);
        }
    }
};

/* One .env line as a single shell WORD, ready to be a `printf '%s\n'` argument. Two layers, one call each:
 * envLine renders the line the .env parser reads back (picking a delimiter the value does not contain),
 * shellQuote carries that line to the host intact.
 *
 * The newline envLine appends is dropped, because printf's format supplies exactly one per argument. Sliced
 * rather than trimmed: a value that itself ends in a newline keeps it, and only the appended one goes.
 */
export const envArg = (key: string, value: string): string => shellQuote(envLine(key, value).slice(0, -1));

/* The write-once .env, chmod 600 whether or not this stack's entries include a secret: it costs nothing on the
 * ones that don't, and it is one rule instead of a per-provider judgement about which values are sensitive.
 *
 * `entries` may be empty and the file is still created. That is not a formality: composeUp passes `--env-file`
 * unconditionally, and compose fails outright on an env file that is not there. The inert `TZ` line is the
 * garage precedent, and its absence is what left the valkey provider unable to bring up a fresh instance.
 *
 * ONE printf for the whole file, with every line as an argument, so the emitted command is a single
 * expression a reader (and authentik's test, which runs it through a real shell) can evaluate on its own.
 */
export const writeEnvOnce = async (session: SshSession, kind: string, dir: string, entries: readonly EnvEntry[]): Promise<void> => {
    const args = (entries.length > 0 ? entries : [{ key: "TZ", value: "Etc/UTC" }]).map((entry) =>
        entry.value === undefined
            ? // Generated on the host and never seen here. Hex, so it holds no character either layer would
              // have to escape, and it rides inside the double quotes rather than through envLine because the
              // substitution has to survive to the host to run there.
              `"${entry.key}='$(openssl rand -hex 32)'"`
            : envArg(entry.key, entry.value),
    );
    await exec(
        session,
        kind,
        `test -f ${dir}/.env || { printf '%s\\n' ${args.join(" ")} > ${dir}/.env && chmod 600 ${dir}/.env; }`,
        `write ${dir}/.env`,
    );
};
