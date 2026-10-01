#!/usr/bin/env node
// Refuses to migrate a Postgres that is not the compose service's own. `docker compose up --wait` proves only that the
// container is healthy, and the `migrate deploy` after it writes to whatever answers on DATABASE_URL. On 2026-10-01 that
// was an intentic sandbox's Postgres, mirrored onto 127.0.0.1:5440 by the machine agent during a Docker Desktop restart:
// the migration built the whole schema in its empty database and the local platform served from it, which looked like a
// wiped database. db:up and db:reset run this between the two halves. It asks both ends for their cluster's system
// identifier: the compose service from inside its container, DATABASE_URL through the Prisma CLI the migration itself
// runs. Node's builtins only: `_tools/scripts` is no package, so a Postgres client here would be a dependency nothing lists.
//
//   node _tools/scripts/db/verify-target.mjs   # exit 0 when DATABASE_URL reaches the compose service's cluster
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../constants/src/node.mjs";

// The service docker-compose.yml runs Postgres as.
const SERVICE = "postgres";
// Asked inside the container, as the image's own user of its own database; `-X` so no psqlrc adds a line to the answer.
const IDENTITY_QUERY = `psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select system_identifier from pg_control_system()"`;
// The probe's two answers. Each is an exception, the only thing `prisma db execute` passes back, and so a probe that
// never ran is not mistaken for either: Prisma exits 0 on an empty script.
const SAME = "verify-target: same cluster";
const DIFFERENT = "verify-target: different cluster";
// A uint64 that Postgres shows as bigint, past 2^53, so it stays a string of digits. Its high half is the initdb time in
// seconds, so a cluster made after January 2038 reads as negative.
const IDENTIFIER = /^-?\d+$/u;
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/u;
// libpq's port when a URL names none.
const DEFAULT_PORT = "5432";

// The cluster identity the compose service printed, or undefined when what it printed is not one.
export const parseSystemIdentifier = (output) => {
    const answer = output.trim();
    return IDENTIFIER.test(answer) ? answer : undefined;
};

// A script that says whether it runs on the cluster `identifier` names. `prisma db execute` reports success or failure
// and no rows, so the comparison runs in the database and both verdicts are raised. The identifier is spliced into the
// SQL, so anything but an integer is refused here rather than sent.
export const sameClusterSql = (identifier) => {
    if (!IDENTIFIER.test(identifier)) {
        throw new Error(`verify-target: ${JSON.stringify(identifier)} is not a system identifier`);
    }
    return `DO $$ BEGIN IF (SELECT system_identifier FROM pg_control_system()) = ${identifier} THEN RAISE EXCEPTION '${SAME}'; ELSE RAISE EXCEPTION '${DIFFERENT}'; END IF; END $$;`;
};

// Where DATABASE_URL points: `{ target }`, named by host and port only for the lines that quote it (the URL carries the
// password), or `{ refusal }` when it is unset or names no host.
export const targetOf = (databaseUrl) => {
    if (databaseUrl === undefined || databaseUrl === "") {
        return { refusal: "DATABASE_URL is set in neither the environment nor the root .env, so there is no database to migrate: copy .env.example to .env." };
    }
    const url = URL.parse(databaseUrl);
    if (url === null || url.hostname === "") {
        return { refusal: "DATABASE_URL is not a URL that names a host, so there is no database to check; .env.example has the one that reaches the compose service." };
    }
    return { target: { host: url.hostname, port: url.port === "" ? DEFAULT_PORT : url.port } };
};

// The refusal for a DATABASE_URL that reaches some other cluster, naming where to look.
export const mismatchMessage = ({ host, port }) => {
    const refusal = `DATABASE_URL (${host}:${port}) reaches a different Postgres than the compose service "${SERVICE}", so migrating would write to the wrong database.`;
    return LOOPBACK.test(host)
        ? `${refusal} Something else holds that port on this machine — an intentic sandbox's mirrored port can (intentic-machine sync mirror ignore --sandbox <id> --port ${port}). See who: ss -ltnp | grep :${port} (Linux), lsof -iTCP:${port} -sTCP:LISTEN (macOS).`
        : `${refusal} db:up and db:reset migrate only the compose service's own; .env.example has the DATABASE_URL that reaches it.`;
};

// A command's output on one line, for a refusal that quotes it.
const oneLine = (lines) =>
    lines
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join(" ");

// The compose service's identity from its `docker compose exec` outcome: `{ identifier }`, or `{ refusal }` saying why
// there is nothing to hold DATABASE_URL against.
export const composeIdentity = ({ code, stdout, stderr }) => {
    const identifier = code === 0 ? parseSystemIdentifier(stdout) : undefined;
    if (identifier !== undefined) {
        return { identifier };
    }
    const said = code === 0 ? `it printed ${JSON.stringify(stdout.trim())}` : oneLine(stderr.split("\n")) || `exit ${code}`;
    return {
        refusal: `could not read the compose service "${SERVICE}"'s cluster identity, so there is nothing to hold DATABASE_URL against (${said}). docker compose ps ${SERVICE} says whether it is running.`,
    };
};

// Prisma's own words from a failed `db execute`, on one line. Its config banner, and the box pnpm draws after an exec
// that failed, say nothing about the database.
export const prismaSaid = (stderr) => {
    const lines = stderr.split("\n");
    const box = lines.findIndex((line) => line.includes("ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL"));
    return oneLine(lines.slice(0, box === -1 ? undefined : box).filter((line) => !line.startsWith("Loaded Prisma config")));
};

// What the probe's outcome means: undefined when DATABASE_URL reached the compose service's cluster, else the refusal.
export const probeRefusal = ({ code, stdout, stderr }, target) => {
    const output = `${stdout}\n${stderr}`;
    if (output.includes(SAME)) {
        return undefined;
    }
    if (output.includes(DIFFERENT)) {
        return mismatchMessage(target);
    }
    const said = code === 0 ? "it exited 0 without either answer, so the script never reached the database" : prismaSaid(stderr) || `exit ${code}`;
    return `could not ask the database at DATABASE_URL (${target.host}:${target.port}) which Postgres it is, so nothing shows it is the compose service "${SERVICE}": ${said}`;
};

/** Runs a command from the repo root and hands back its outcome; a non-zero exit is an answer here, never a throw. */
const run = (root, file, args, input) => {
    // The update notice Prisma prints would otherwise ride into a refusal that quotes it.
    const result = spawnSync(file, args, { cwd: root, encoding: "utf8", input, env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" } });
    return result.error === undefined
        ? { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
        : { code: 127, stdout: "", stderr: `${file}: ${result.error.message}` };
};

// Why DATABASE_URL must not be migrated from here, or undefined when it reaches the compose service's cluster.
const refusalFor = (root, databaseUrl) => {
    const pointed = targetOf(databaseUrl);
    if (pointed.target === undefined) {
        return pointed.refusal;
    }
    const compose = composeIdentity(run(root, "docker", ["compose", "exec", "-T", SERVICE, "sh", "-c", IDENTITY_QUERY]));
    if (compose.identifier === undefined) {
        return compose.refusal;
    }
    const probe = run(root, "pnpm", ["--filter", "@intentic/prisma", "exec", "prisma", "db", "execute", "--stdin"], sameClusterSql(compose.identifier));
    return probeRefusal(probe, pointed.target);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const root = repoRoot(import.meta.url);
    // The root .env, loaded the way prisma.config.ts loads it (the environment wins over the file), so this asks about
    // the URL the migration is about to use.
    const rootEnv = join(root, ".env");
    if (existsSync(rootEnv)) {
        process.loadEnvFile(rootEnv);
    }
    const reason = refusalFor(root, process.env.DATABASE_URL);
    if (reason === undefined) {
        console.log(`verify-target: DATABASE_URL reaches the compose service "${SERVICE}".`);
    } else {
        console.error(`verify-target: ${reason}`);
        process.exitCode = 1;
    }
}
