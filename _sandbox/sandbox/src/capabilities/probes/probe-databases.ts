import mysql from "mysql2/promise";
import { Client } from "pg";
import { type DatabaseClients, type DatabaseSession, type DialError, dialError, type DialTarget } from "./probe-dial.js";

// The two database sign-ins the pre-save test makes (probe-dial.ts), through the same client libraries a Node program
// would use: pg for PostgreSQL, mysql2 for MySQL and MariaDB. Both negotiate TLS the way their command-line clients do
// by default (psql's sslmode=prefer, mysql's ssl-mode=PREFERRED): encrypted when the server offers it, its certificate
// not checked, plain when it does not. The card's own client (psql, mysql) then connects the same way.

const PROBE_TIMEOUT_MS = 10_000;
// Read-only and a single row: who the server says signed in, to which database, and its version.
const POSTGRES_ASK = `SELECT current_setting('server_version') AS version, current_database() AS database, current_user AS "user"`;
const MYSQL_ASK = "SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS user";

// Whether a client's failure is the server turning TLS down, which is the cue to try again without it. mysql2 names it
// by code; pg names it by nothing but its sentence.
const mysqlRefusedTls = (failure: DialError): boolean => failure.code === "HANDSHAKE_NO_SSL_SUPPORT";
const postgresRefusedTls = (failure: DialError): boolean =>
    // allow(dependency-text): pg (lib/connection.js) throws this one sentence, with no code, when the server answers its SSLRequest with "N"; an unmatched wording leaves the TLS attempt's own failure as the answer.
    failure.message === "The server does not support SSL connections";

// Tries with TLS, and once more without it if the server has none to offer (`refusedTls` reads the client's failure).
const preferTls = async <T>(refusedTls: (failure: DialError) => boolean, dial: (tls: boolean) => Promise<T>): Promise<T> => {
    try {
        return await dial(true);
    } catch (error) {
        if (refusedTls(dialError(error))) {
            return dial(false);
        }
        throw error;
    }
};

// Hangs up once the answer is in, or the dial failed.
const hangUp = async (end: () => Promise<void>): Promise<void> => {
    // allow(silent-catch): the probe has its answer (or its failure) already; a connection that will not close cleanly changes neither, and its socket goes with it.
    await end().catch(() => undefined);
};

const postgres = (target: DialTarget): Promise<DatabaseSession> =>
    preferTls(postgresRefusedTls, async (tls) => {
        const client = new Client({
            host: target.host,
            port: target.port,
            user: target.user,
            password: target.password,
            database: target.database === "" ? undefined : target.database,
            ssl: tls ? { rejectUnauthorized: false } : false,
            connectionTimeoutMillis: PROBE_TIMEOUT_MS,
            query_timeout: PROBE_TIMEOUT_MS,
            application_name: "intentic-probe",
        });
        // A server that drops the connection after it was refused reports it here too; the refusal is already the answer.
        client.on("error", () => undefined);
        try {
            await client.connect();
            const row = (await client.query<{ version: string; database: string; user: string }>(POSTGRES_ASK)).rows[0];
            return { version: row?.version ?? "", database: row?.database ?? target.database, user: row?.user ?? target.user };
        } finally {
            await hangUp(() => client.end());
        }
    });

const mysqlSession = (target: DialTarget): Promise<DatabaseSession> =>
    preferTls(mysqlRefusedTls, async (tls) => {
        const options: mysql.ConnectionOptions = { host: target.host, port: target.port, user: target.user, password: target.password, connectTimeout: PROBE_TIMEOUT_MS };
        if (target.database !== "") {
            options.database = target.database;
        }
        if (tls) {
            options.ssl = { rejectUnauthorized: false };
        }
        const connection = await mysql.createConnection(options);
        try {
            const [rows] = await connection.query<mysql.RowDataPacket[]>({ sql: MYSQL_ASK, timeout: PROBE_TIMEOUT_MS });
            const row = rows[0];
            return { version: String(row?.["version"] ?? ""), database: String(row?.["db"] ?? target.database), user: String(row?.["user"] ?? target.user) };
        } finally {
            await hangUp(() => connection.end());
        }
    });

export const DATABASE_CLIENTS: DatabaseClients = { postgres, mysql: mysqlSession };
