import type { Provider, ResolvedInputs } from "@intentic/engine";
import { shellQuote, sqlIdentifier, sqlLiteral } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { containerId } from "../core/backing-ssh.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { type SshSession, type SshExecutor, sshExecutor } from "../core/ssh.js";

const databaseSchema = sshSchema.extend({
    // The id of the Postgres instance container to docker-exec into (stamped intentic.id=<instance>).
    instance: z.string(),
    // The instance's host-internal coordinates, embedded in the produced connection URL.
    instanceHost: z.string(),
    instancePort: z.string(),
    // The per-app database, its owning role (same name), and the role's generated password.
    database: z.string(),
    role: z.string(),
    password: z.string(),
});
type DatabaseInputs = z.infer<typeof databaseSchema>;
const parse = (inputs: ResolvedInputs): DatabaseInputs => parseInputs(databaseSchema, inputs, "postgres-database");

const url = (parsed: DatabaseInputs): string =>
    `postgres://${parsed.role}:${parsed.password}@${parsed.instanceHost}:${parsed.instancePort}/${parsed.database}`;

// Run psql in the instance container as the superuser over the local socket (trust auth), returning trimmed
// stdout. Throws on a non-zero exit so a real psql/connection error propagates rather than reads as "absent".
const psql = async (session: SshSession, cid: string, sql: string): Promise<string> => {
    // The statement rides as ONE argv word. It used to be spliced into a shell double-quoted string, which is
    // why every caller below had to spell its identifiers `\\"name\\"`, interleaving the shell's escaping with
    // SQL's by hand, in a template, at each site. shellQuote owns the outer layer now; callers write SQL.
    const result = await session.exec(`docker exec ${cid} psql -U postgres -tAc ${shellQuote(sql)}`);
    if (result.code !== 0) {
        throw new Error(`psql failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
};

// A per-app Postgres database + owning role on a shared instance (the binding for an app that uses a database
// capability). read reports it present once the database exists (so the noop re-derives the URL); apply
// create-or-updates the role (idempotent: CREATE if absent, always ALTER to match the generated password) and
// CREATEs the database if absent; delete drops both. All identifiers are resolver-sanitized to [a-z0-9_].
export const createPostgresDatabaseProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently),
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "instanceHost", "instancePort")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`postgres-database "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            const cid = await containerId(session, parsed.instance);
            if (cid === "") {
                return undefined;
            }
            const exists = await psql(session, cid, `SELECT 1 FROM pg_database WHERE datname=${sqlLiteral(parsed.database)}`);
            return exists === "1" ? { outputs: { url: url(parsed) } } : undefined;
        } finally {
            await session.dispose();
        }
    },
    // The database/role names + the (stable, generated) password never drift, so a present database is a noop.
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            const cid = await containerId(session, parsed.instance);
            if (cid === "") {
                throw new Error(`postgres-database "${ctx.id}": instance "${parsed.instance}" is not running`);
            }
            const roleExists = await psql(session, cid, `SELECT 1 FROM pg_roles WHERE rolname=${sqlLiteral(parsed.role)}`);
            if (roleExists !== "1") {
                await psql(session, cid, `CREATE ROLE ${sqlIdentifier(parsed.role)} LOGIN PASSWORD ${sqlLiteral(parsed.password)}`);
            } else {
                await psql(session, cid, `ALTER ROLE ${sqlIdentifier(parsed.role)} LOGIN PASSWORD ${sqlLiteral(parsed.password)}`);
            }
            const dbExists = await psql(session, cid, `SELECT 1 FROM pg_database WHERE datname=${sqlLiteral(parsed.database)}`);
            if (dbExists !== "1") {
                await psql(session, cid, `CREATE DATABASE ${sqlIdentifier(parsed.database)} OWNER ${sqlIdentifier(parsed.role)}`);
            }
            return { url: url(parsed) };
        } finally {
            await session.dispose();
        }
    },
    delete: async (inputs, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            const cid = await containerId(session, parsed.instance);
            if (cid === "") {
                ctx.log(`postgres-database "${ctx.id}": instance "${parsed.instance}" already gone; nothing to drop`);
                return;
            }
            await psql(session, cid, `DROP DATABASE IF EXISTS ${sqlIdentifier(parsed.database)}`);
            await psql(session, cid, `DROP ROLE IF EXISTS ${sqlIdentifier(parsed.role)}`);
        } finally {
            await session.dispose();
        }
    },
});
