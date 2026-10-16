import { errnoCode, errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { spawnSync } from "node:child_process";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The pre-migration backup: the first step of the image's boot chain (Dockerfile CMD), before `prisma migrate deploy`.
 * When the database has migrations pending, it pg_dumps the database into MIGRATION_BACKUP_DIR, a persistent volume, and
 * a failed dump stops the boot before anything is migrated. Restoring is in the api README.
 *
 * Why a dump and not a down migration: the history is append-only with no down migrations, several migrations drop or
 * rename, and rolling the api image back past a migration cannot work, since the old image's boot refuses the newer
 * schema (`migrate diff --exit-code`). The dump taken just before a migration is the only way back.
 *
 *   MIGRATION_BACKUP_DIR     where dumps go (default /backups, the compose file's migration-backups volume)
 *   MIGRATION_BACKUP_KEEP    how many dumps to keep (default 10)
 *   MIGRATE_WITHOUT_BACKUP   1 or true: migrate even when the dump failed. For an operator who has a backup of their own.
 *
 * Its own three variables rather than fields in config.ts, because it runs before the api and loading the api's config
 * would make a migration wait on settings that have nothing to do with it.
 */

const DEFAULT_BACKUP_DIR = `/backups`;
const DEFAULT_KEEP = 10;
const PREFIX = `pre-migrate_`;
const SUFFIX = `.dump`;
const PARTIAL = `.partial`;
// A label longer than this (sixty migrations on a fresh database) names its first and last instead of all of them.
const LABEL_BUDGET = 160;
// Written when `migrate status` failed without naming anything: the database is unreachable (and the dump will fail
// too) or in a state the migration would stop on. Either way a dump before trying costs little.
export const UNKNOWN_LABEL = `status-unknown`;

export type BackupSettings = { dir: string; keep: number; migrateWithoutBackup: boolean };

/** The three variables, empty read as unset like every other api setting. Throws on a KEEP that is not a whole number above 0. */
export function readSettings(env: Record<string, string | undefined>): BackupSettings {
    const dir = env[`MIGRATION_BACKUP_DIR`] || DEFAULT_BACKUP_DIR;
    const keepText = env[`MIGRATION_BACKUP_KEEP`] || String(DEFAULT_KEEP);
    const keep = Number(keepText);
    if (!Number.isInteger(keep) || keep < 1) {
        throw new Error(`MIGRATION_BACKUP_KEEP must be a whole number of at least 1, not "${keepText}"`);
    }
    const override = (env[`MIGRATE_WITHOUT_BACKUP`] ?? ``).trim().toLowerCase();
    return { dir, keep, migrateWithoutBackup: override === `1` || override === `true` };
}

/**
 * The pending migrations in `prisma migrate status` output: every line that is exactly the name of a migration this image
 * carries, in the image's order. Matching names rather than the sentence around them survives Prisma rewording it, and a
 * failed migration, printed by name too, counts as pending: it has not applied.
 */
export function pendingFromStatus(output: string, known: readonly string[]): string[] {
    const lines = new Set(output.split(/\r?\n/).map((line) => line.trim()));
    return known.filter((name) => lines.has(name));
}

/** What the dump is named after: the pending migrations joined by `+`, or the first and last of them and a count. */
export function backupLabel(pending: readonly string[]): string {
    if (pending.length === 0) {
        return UNKNOWN_LABEL;
    }
    const all = pending.join(`+`);
    return all.length <= LABEL_BUDGET ? all : `${pending[0]}..${pending.at(-1)}_${pending.length}-migrations`;
}

/** `pre-migrate_20261015T093000Z_<label>.dump`: UTC, to the second, so names sort in the order they were taken. */
export function backupFileName(at: Date, label: string): string {
    const stamp = at
        .toISOString()
        .replace(/\.\d{3}Z$/, `Z`)
        .replaceAll(/[-:]/g, ``);
    return `${PREFIX}${stamp}_${label}${SUFFIX}`;
}

const NAME = /^pre-migrate_(\d{8}T\d{6}Z)_(.+)\.dump$/;

export function parseBackupName(name: string): { stamp: string; label: string } | undefined {
    const match = NAME.exec(name);
    return match?.[1] === undefined || match[2] === undefined ? undefined : { stamp: match[1], label: match[2] };
}

/**
 * Which dumps to delete so `keep` remain. The newest are kept, with one exception that comes first: of several dumps for
 * the same pending migrations only the oldest and the newest survive. A migration that fails leaves the api restarting
 * every minute, and each start dumps again; without this, ten restarts would rotate out the one dump taken before the
 * first attempt. The newest of the set stays too, since a set can come back pending after a restore, over newer data.
 */
export function backupsToDelete(names: readonly string[], keep: number): string[] {
    const dumps = names
        .map((name) => ({ name, parsed: parseBackupName(name) }))
        .filter((entry) => entry.parsed !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));
    const byLabel = new Map<string, string[]>();
    for (const { name, parsed } of dumps) {
        const label = parsed?.label ?? ``;
        byLabel.set(label, [...(byLabel.get(label) ?? []), name]);
    }
    const repeats = new Set([...byLabel.values()].flatMap((group) => group.slice(1, -1)));
    const survivors = dumps.map((entry) => entry.name).filter((name) => !repeats.has(name));
    const aged = survivors.slice(0, Math.max(0, survivors.length - keep));
    return [...repeats, ...aged].sort();
}

type LibpqVariable =
    `PGHOST` | `PGPORT` | `PGUSER` | `PGPASSWORD` | `PGDATABASE` | `PGSSLMODE` | `PGSSLROOTCERT` | `PGSSLCERT` | `PGSSLKEY` | `PGCONNECT_TIMEOUT`;
/** The libpq environment pg_dump and pg_restore connect with. */
export type LibpqEnv = Partial<Record<LibpqVariable, string>> & { PGAPPNAME: string };

// libpq's own connection parameters that can ride a Prisma URL's query string. Prisma's own (schema, connection_limit,
// pool_timeout, pgbouncer, …) are dropped: pg_dump refuses a URI carrying a parameter it does not know.
const LIBPQ_PARAMS = new Map<string, LibpqVariable>([
    [`host`, `PGHOST`],
    [`port`, `PGPORT`],
    [`sslmode`, `PGSSLMODE`],
    [`sslrootcert`, `PGSSLROOTCERT`],
    [`sslcert`, `PGSSLCERT`],
    [`sslkey`, `PGSSLKEY`],
    [`connect_timeout`, `PGCONNECT_TIMEOUT`],
]);

/** DATABASE_URL as libpq environment variables, so the password never appears in pg_dump's argv. */
export function pgEnvFromUrl(url: string): LibpqEnv {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch (error) {
        throw new Error(`DATABASE_URL is not a URL (${errorMessage(error)})`, { cause: error });
    }
    if (parsed.protocol !== `postgresql:` && parsed.protocol !== `postgres:`) {
        throw new Error(`DATABASE_URL is not a postgresql:// URL`);
    }
    const env: LibpqEnv = { PGAPPNAME: `intentic-migration-backup` };
    const set = (key: LibpqVariable, value: string) => {
        if (value !== ``) {
            env[key] = value;
        }
    };
    set(`PGHOST`, decodeURIComponent(parsed.hostname).replace(/^\[(.*)\]$/, `$1`));
    set(`PGPORT`, parsed.port);
    set(`PGUSER`, decodeURIComponent(parsed.username));
    set(`PGPASSWORD`, decodeURIComponent(parsed.password));
    set(`PGDATABASE`, decodeURIComponent(parsed.pathname.replace(/^\//, ``)));
    for (const [key, value] of parsed.searchParams) {
        const name = LIBPQ_PARAMS.get(key);
        if (name !== undefined) {
            set(name, value);
        }
    }
    return env;
}

// Resolved from this file, so the same paths hold in the image (/app) and in a checkout (_platform/api).
const APP = fileURLToPath(new URL(`..`, import.meta.url));
const PRISMA_CLI = join(APP, `node_modules/prisma/build/index.js`);
const PRISMA_PACKAGE = join(APP, `node_modules/@intentic/prisma`);

const log = (line: string) => process.stdout.write(`[migration-backup] ${line}\n`);
const fail = (line: string) => process.stderr.write(`[migration-backup] ${line}\n`);

async function migrationNames(): Promise<string[]> {
    const entries = await readdir(join(PRISMA_PACKAGE, `migrations`), { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

type Status = { pending: string[]; upToDate: boolean; output: string };

async function migrationStatus(): Promise<Status> {
    const result = spawnSync(process.execPath, [PRISMA_CLI, `migrate`, `status`, `--config`, join(PRISMA_PACKAGE, `prisma.config.ts`)], {
        cwd: APP,
        // CHECKPOINT_DISABLE: Prisma would otherwise call home for an update check on every boot.
        env: { ...process.env, CHECKPOINT_DISABLE: `1` },
        encoding: `utf8`,
        stdio: [`ignore`, `pipe`, `pipe`],
    });
    const output = `${result.stdout ?? ``}${result.stderr ?? ``}`;
    if (result.error !== undefined) {
        throw new Error(`could not run prisma migrate status: ${result.error.message}`, { cause: result.error });
    }
    return { pending: pendingFromStatus(output, await migrationNames()), upToDate: result.status === 0, output };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
    const result = spawnSync(command, args, { env, stdio: [`ignore`, `inherit`, `inherit`] });
    if (result.error !== undefined) {
        const missing = errnoCode(result.error) === `ENOENT`;
        throw new Error(missing ? `${command} is not installed in this image (the Dockerfile installs postgresql-client)` : result.error.message, {
            cause: result.error,
        });
    }
    if (result.status !== 0) {
        throw new Error(`${command} exited ${result.status ?? `on signal ${result.signal}`}`);
    }
}

async function requireDirectory(dir: string): Promise<void> {
    const found = await stat(dir).catch(undefinedIfMissing);
    if (found === undefined || !found.isDirectory()) {
        throw new Error(
            `${dir} does not exist: mount a persistent volume there (the platform compose file's migration-backups volume) or point MIGRATION_BACKUP_DIR at one`,
        );
    }
}

/** Dump to `<name>.partial`, prove pg_restore can read it, and only then give it its name. Returns the dump's path. */
async function takeDump(settings: BackupSettings, label: string, databaseUrl: string): Promise<string> {
    await requireDirectory(settings.dir);
    for (const stale of (await readdir(settings.dir)).filter((name) => name.startsWith(PREFIX) && name.endsWith(PARTIAL))) {
        await rm(join(settings.dir, stale), { force: true });
    }
    const target = join(settings.dir, backupFileName(new Date(), label));
    const partial = `${target}${PARTIAL}`;
    const env = { ...process.env, ...pgEnvFromUrl(databaseUrl) };
    try {
        // Custom format: compressed, and pg_restore can restore any part of it. --lock-wait-timeout so a dump queued
        // behind a lock fails the boot instead of hanging it.
        run(`pg_dump`, [`--format=custom`, `--compress=6`, `--no-password`, `--lock-wait-timeout=60s`, `--file=${partial}`], env);
        run(`pg_restore`, [`--list`, `--file=/dev/null`, partial], env);
        await rename(partial, target);
    } catch (error) {
        await rm(partial, { force: true });
        throw error;
    }
    return target;
}

async function prune(settings: BackupSettings): Promise<void> {
    for (const name of backupsToDelete(await readdir(settings.dir), settings.keep)) {
        await rm(join(settings.dir, name), { force: true });
        log(`removed ${name} (keeping ${settings.keep})`);
    }
}

async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
    const settings = readSettings(env);
    const databaseUrl = env[`DATABASE_URL`];
    if (databaseUrl === undefined || databaseUrl === ``) {
        fail(`DATABASE_URL is not set`);
        return 1;
    }
    const status = await migrationStatus();
    if (status.upToDate) {
        log(`no migrations pending, nothing to back up`);
        return 0;
    }
    if (status.pending.length === 0) {
        log(`prisma migrate status did not name a pending migration and did not say the schema is up to date; backing up anyway:`);
        process.stdout.write(status.output);
    } else {
        log(`${status.pending.length} migration(s) pending: ${status.pending.join(`, `)}`);
    }
    let target: string;
    try {
        target = await takeDump(settings, backupLabel(status.pending), databaseUrl);
    } catch (error) {
        const reason = errorMessage(error);
        if (settings.migrateWithoutBackup) {
            fail(`BACKUP FAILED (${reason}); migrating anyway because MIGRATE_WITHOUT_BACKUP is set`);
            return 0;
        }
        fail(`backup failed, so nothing was migrated: ${reason}`);
        fail(`fix the backup, or set MIGRATE_WITHOUT_BACKUP=1 for one boot to migrate without it (README: Restoring from a pre-migration backup)`);
        return 1;
    }
    log(`backed up to ${target} (${(await stat(target)).size} bytes)`);
    try {
        await prune(settings);
    } catch (error) {
        // The dump exists; an old one left behind is no reason to stop the migration it was taken for.
        fail(`could not prune old backups: ${errorMessage(error)}`);
    }
    return 0;
}

if (import.meta.main) {
    try {
        process.exitCode = await main();
    } catch (error) {
        fail(errorMessage(error));
        process.exitCode = 1;
    }
}
