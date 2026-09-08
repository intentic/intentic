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
// stdout. Throws on a non-zero exit rather than reading it as "absent".
const psql = async (session: SshSession, cid: string, sql: string): Promise<string> => {
    // The statement rides as one argv word: shellQuote owns the shell-escaping layer, callers write plain SQL.
    const result = await session.exec(`docker exec ${cid} psql -U postgres -tAc ${shellQuote(sql)}`);
    if (result.code !== 0) {
        throw new Error(`psql failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
};

const databaseExists = async (session: SshSession, cid: string, parsed: DatabaseInputs): Promise<boolean> =>
    (await psql(session, cid, `SELECT 1 FROM pg_database WHERE datname=${sqlLiteral(parsed.database)}`)) === "1";

// A per-app Postgres database + owning role on a shared instance. All identifiers are resolver-sanitized to
// [a-z0-9_].
export const createPostgresDatabaseProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createInstanceBindingProvider(
        {
            kind: "postgres-database",
            schema: databaseSchema,
            pendingRefs: ["instanceHost", "instancePort"],
            present: async (session, cid, parsed) => ((await databaseExists(session, cid, parsed)) ? { url: url(parsed) } : undefined),
            create: async (session, cid, parsed) => {
                const roleExists = await psql(session, cid, `SELECT 1 FROM pg_roles WHERE rolname=${sqlLiteral(parsed.role)}`);
                // ALTER rather than skip on the already-there path: the password is generated and stored in the graph,
                // so this
                // keeps the instance agreeing with the URL the app was handed.
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
