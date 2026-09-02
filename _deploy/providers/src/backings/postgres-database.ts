import type { Provider } from "@intentic/engine";
import { shellQuote, sqlIdentifier, sqlLiteral } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { bindingSchema, createInstanceBindingProvider } from "../core/instance-binding.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

const databaseSchema = bindingSchema.extend({
    // The instance's host-internal coordinates, embedded in the produced connection URL.
    instanceHost: z.string(),
    instancePort: z.string(),
    // The per-app database, its owning role (same name), and the role's generated password.
    database: z.string(),
    role: z.string(),
    password: z.string(),
});
type DatabaseInputs = z.infer<typeof databaseSchema>;

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

const databaseExists = async (session: SshSession, cid: string, parsed: DatabaseInputs): Promise<boolean> =>
    (await psql(session, cid, `SELECT 1 FROM pg_database WHERE datname=${sqlLiteral(parsed.database)}`)) === "1";

// A per-app Postgres database + owning role on a shared instance (the binding for an app that uses a database
// capability). read reports it present once the database exists (so the noop re-derives the URL); apply
// create-or-updates the role (idempotent: CREATE if absent, always ALTER to match the generated password) and
// CREATEs the database if absent; delete drops both. All identifiers are resolver-sanitized to [a-z0-9_].
export const createPostgresDatabaseProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createInstanceBindingProvider(
        {
            kind: "postgres-database",
            schema: databaseSchema,
            pendingRefs: ["instanceHost", "instancePort"],
            present: async (session, cid, parsed) => ((await databaseExists(session, cid, parsed)) ? { url: url(parsed) } : undefined),
            create: async (session, cid, parsed) => {
                const roleExists = await psql(session, cid, `SELECT 1 FROM pg_roles WHERE rolname=${sqlLiteral(parsed.role)}`);
                // ALTER rather than skip on the already-there path: the password is generated and stored in the
                // graph, so this is what keeps the instance agreeing with the URL the app was handed.
                const verb = roleExists === "1" ? "ALTER" : "CREATE";
                await psql(session, cid, `${verb} ROLE ${sqlIdentifier(parsed.role)} LOGIN PASSWORD ${sqlLiteral(parsed.password)}`);
                if (!(await databaseExists(session, cid, parsed))) {
                    await psql(session, cid, `CREATE DATABASE ${sqlIdentifier(parsed.database)} OWNER ${sqlIdentifier(parsed.role)}`);
                }
                return { url: url(parsed) };
            },
            drop: async (session, cid, parsed) => {
                await psql(session, cid, `DROP DATABASE IF EXISTS ${sqlIdentifier(parsed.database)}`);
                await psql(session, cid, `DROP ROLE IF EXISTS ${sqlIdentifier(parsed.role)}`);
            },
        },
        executor,
    );
