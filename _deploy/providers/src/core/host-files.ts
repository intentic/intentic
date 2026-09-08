import { envLine, shellQuote } from "@intentic/sandbox-run/quote";
import type { SshSession } from "./ssh.js";

// Writes a compose stack's config and secrets onto a host; shared by compose-service.ts and backing-provider.ts.
// envLine and shellQuote must both quote each .env value, one for the file, one for the host shell. Config is
// rewritten every apply; the .env is written once, since its secrets are baked into the instance's first-init data.

// One line of the write-once .env: a literal `value`, or omitted to have the host generate one with `openssl rand -hex
// 32`.
export interface EnvEntry {
    readonly key: string;
    readonly value?: string;
}

// A config file's content and whether it carries a secret (chmod 600 after write); a plain string is the same with no
// secret.
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

// Writes the state dir and its config files, rewritten every apply. The heredoc is quoted (`<<'MARKER'`) so the
// host shell does not expand the `$VARIABLE` references meant for compose.
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

// One .env line as a single shell word for a `printf '%s\n'` argument: envLine renders it, shellQuote quotes it
// for the host. Sliced, not trimmed, to drop only envLine's own trailing newline.
export const envArg = (key: string, value: string): string => shellQuote(envLine(key, value).slice(0, -1));

// Write-once .env, chmod 600 regardless of whether any entry is a secret. Created even with no entries, since
// composeUp always passes `--env-file`; written as one printf so the whole file is a single shell expression.
export const writeEnvOnce = async (session: SshSession, kind: string, dir: string, entries: readonly EnvEntry[]): Promise<void> => {
    const args = (entries.length > 0 ? entries : [{ key: "TZ", value: "Etc/UTC" }]).map((entry) =>
        entry.value === undefined
            ? // Generated on the host, never seen here; hex needs no escaping in either layer.
              // Rides in double quotes rather than envLine, so the substitution runs on the host.
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
