import {
    backupFileName,
    backupLabel,
    backupsToDelete,
    parseBackupName,
    pendingFromStatus,
    pgEnvFromUrl,
    readSettings,
    UNKNOWN_LABEL,
} from "./migration-backup.js";

// The boot chain's pre-migration backup (migration-backup.ts): what it reads, what it names a dump, which dumps it keeps.

const KNOWN = [`20261010120000_local_wake`, `20261012120000_hosted_probation`, `20261013120000_organisations`];

// `prisma migrate status` as Prisma 7 prints a database two migrations behind.
const BEHIND = [
    `Prisma schema loaded from node_modules/@intentic/prisma/schema.prisma`,
    `Datasource "db": PostgreSQL database "intentic", schema "public" at "postgres:5432"`,
    ``,
    `3 migrations found in prisma/migrations`,
    `Following migrations have not yet been applied:`,
    `20261012120000_hosted_probation`,
    `20261013120000_organisations`,
    ``,
    `To apply migrations in development run prisma migrate dev.`,
    `To apply migrations in production run prisma migrate deploy.`,
].join(`\n`);

describe(`the pending migrations`, () => {
    it(`are the lines of migrate status that name a migration this image carries, in the image's order`, () => {
        expect(pendingFromStatus(BEHIND, KNOWN)).toEqual([`20261012120000_hosted_probation`, `20261013120000_organisations`]);
    });

    it(`are none for an up-to-date database, whose count line mentions no name`, () => {
        expect(pendingFromStatus(`3 migrations found in prisma/migrations\n\nDatabase schema is up to date!\n`, KNOWN)).toEqual([]);
    });

    it(`include a failed migration, which has not applied`, () => {
        const failed = `Following migration have failed:\r\n20261013120000_organisations\r\n\r\nDuring development if the failed migration…`;
        expect(pendingFromStatus(failed, KNOWN)).toEqual([`20261013120000_organisations`]);
    });

    it(`ignore a name that is only part of a line`, () => {
        expect(pendingFromStatus(`The last common migration is: 20261010120000_local_wake`, KNOWN)).toEqual([]);
    });
});

describe(`a dump's name`, () => {
    const at = new Date(`2026-10-15T09:30:05.123Z`);

    it(`starts with the UTC time to the second and names the pending migrations`, () => {
        expect(backupFileName(at, backupLabel([`20261012120000_hosted_probation`, `20261013120000_organisations`]))).toBe(
            `pre-migrate_20261015T093005Z_20261012120000_hosted_probation+20261013120000_organisations.dump`,
        );
    });

    it(`names the first and last of a list too long for a file name`, () => {
        const sixty = Array.from({ length: 60 }, (_, index) => `202607${String(index).padStart(8, `0`)}_migration_${index}`);
        const label = backupLabel(sixty);
        expect(label).toBe(`20260700000000_migration_0..20260700000059_migration_59_60-migrations`);
        expect(backupFileName(at, label).length).toBeLessThan(255);
    });

    it(`says the status was unknown when no migration was named`, () => {
        expect(backupLabel([])).toBe(UNKNOWN_LABEL);
    });

    it(`reads back into its time and label, and nothing else does`, () => {
        expect(parseBackupName(`pre-migrate_20261015T093005Z_20261013120000_organisations.dump`)).toEqual({
            stamp: `20261015T093005Z`,
            label: `20261013120000_organisations`,
        });
        expect(parseBackupName(`pre-migrate_20261015T093005Z_20261013120000_organisations.dump.partial`)).toBeUndefined();
        expect(parseBackupName(`lost+found`)).toBeUndefined();
    });
});

describe(`retention`, () => {
    const dump = (stamp: string, label: string) => `pre-migrate_${stamp}_${label}.dump`;

    it(`keeps the newest, oldest first out`, () => {
        const names = [1, 2, 3, 4, 5].map((day) => dump(`2026100${day}T120000Z`, `m${day}`));
        expect(backupsToDelete(names, 3)).toEqual(names.slice(0, 2));
        expect(backupsToDelete(names, 5)).toEqual([]);
        expect(backupsToDelete(names, 10)).toEqual([]);
    });

    it(`judges by the time in the name, not the order it is listed in`, () => {
        const older = dump(`20261001T120000Z`, `m1`);
        const newer = dump(`20261002T120000Z`, `m2`);
        expect(backupsToDelete([newer, older], 1)).toEqual([older]);
    });

    it(`keeps the dump from before a failing migration's first attempt through any number of restarts`, () => {
        const before = [dump(`20261001T120000Z`, `m1`), dump(`20261002T120000Z`, `m2`)];
        const restarts = Array.from({ length: 30 }, (_, minute) => dump(`20261003T12${String(minute).padStart(2, `0`)}00Z`, `m3`));
        const deleted = backupsToDelete([...before, ...restarts], 10);
        const kept = [...before, ...restarts].filter((name) => !deleted.includes(name));
        expect(kept).toEqual([...before, ...restarts.slice(0, 1), ...restarts.slice(-1)]);
    });

    it(`leaves files that are not its dumps alone`, () => {
        const names = [`lost+found`, `notes.txt`, `pre-migrate_20261001T120000Z_m1.dump.partial`, dump(`20261001T120000Z`, `m1`)];
        expect(backupsToDelete(names, 1)).toEqual([]);
    });
});

describe(`the connection pg_dump gets`, () => {
    it(`is DATABASE_URL taken apart into libpq variables, the password decoded`, () => {
        expect(pgEnvFromUrl(`postgresql://intentic:p%40ss@postgres:5432/intentic`)).toEqual({
            PGAPPNAME: `intentic-migration-backup`,
            PGHOST: `postgres`,
            PGPORT: `5432`,
            PGUSER: `intentic`,
            PGPASSWORD: `p@ss`,
            PGDATABASE: `intentic`,
        });
    });

    it(`keeps libpq's own parameters and drops Prisma's, which pg_dump would refuse`, () => {
        const env = pgEnvFromUrl(`postgres://u@db.example/app?schema=public&connection_limit=5&sslmode=require&connect_timeout=10`);
        expect(env).toEqual({
            PGAPPNAME: `intentic-migration-backup`,
            PGHOST: `db.example`,
            PGUSER: `u`,
            PGDATABASE: `app`,
            PGSSLMODE: `require`,
            PGCONNECT_TIMEOUT: `10`,
        });
    });

    it(`refuses anything that is not a postgres URL`, () => {
        expect(() => pgEnvFromUrl(`mysql://u@h/db`)).toThrow(`not a postgresql:// URL`);
        expect(() => pgEnvFromUrl(`not a url`)).toThrow(`DATABASE_URL is not a URL`);
    });
});

describe(`the settings`, () => {
    it(`default to /backups and ten dumps, and refuse to migrate without one`, () => {
        expect(readSettings({})).toEqual({ dir: `/backups`, keep: 10, migrateWithoutBackup: false });
        expect(readSettings({ MIGRATION_BACKUP_DIR: ``, MIGRATION_BACKUP_KEEP: `` })).toEqual({
            dir: `/backups`,
            keep: 10,
            migrateWithoutBackup: false,
        });
    });

    it(`read the override only as an explicit yes`, () => {
        expect(readSettings({ MIGRATE_WITHOUT_BACKUP: `1` }).migrateWithoutBackup).toBe(true);
        expect(readSettings({ MIGRATE_WITHOUT_BACKUP: `TRUE` }).migrateWithoutBackup).toBe(true);
        expect(readSettings({ MIGRATE_WITHOUT_BACKUP: `0` }).migrateWithoutBackup).toBe(false);
        expect(readSettings({ MIGRATE_WITHOUT_BACKUP: `yes please` }).migrateWithoutBackup).toBe(false);
    });

    it(`refuse a count that keeps nothing or is not a number`, () => {
        expect(readSettings({ MIGRATION_BACKUP_KEEP: `3` }).keep).toBe(3);
        expect(() => readSettings({ MIGRATION_BACKUP_KEEP: `0` })).toThrow(`MIGRATION_BACKUP_KEEP`);
        expect(() => readSettings({ MIGRATION_BACKUP_KEEP: `ten` })).toThrow(`MIGRATION_BACKUP_KEEP`);
    });
});
