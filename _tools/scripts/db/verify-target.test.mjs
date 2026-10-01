// Pins what the guard between db:up's container and its migration concludes from the answers it gathers: where
// DATABASE_URL points, the compose service's cluster identity, and the probe run through Prisma. No Docker: the outputs
// are canned from real runs (pnpm 12, Prisma 7.10), with the checkout's path shortened.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeIdentity, mismatchMessage, parseSystemIdentifier, prismaSaid, probeRefusal, sameClusterSql, targetOf } from "./verify-target.mjs";

// The compose service's identifier on the machine this was written on: past 2^53, so a Number would round it.
const IDENTIFIER = "7663961090417463335";
const LOCAL = { host: "localhost", port: "5440" };
const BOX = '\nError: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL\n\n  × "pnpm recursive exec" failed in /checkout/_platform/prisma\n';
// What `prisma db execute --stdin` printed through pnpm: the probe's two answers, an empty script, and no server on the
// port at all.
const raised = (answer) => ({ code: 1, stdout: "", stderr: `Loaded Prisma config from prisma.config.ts.\n\nError: ERROR: verify-target: ${answer}\n\n${BOX}` });
const EMPTY_SCRIPT = { code: 0, stdout: "Script executed successfully.\n", stderr: "Loaded Prisma config from prisma.config.ts.\n\n" };
const UNREACHABLE = `Loaded Prisma config from prisma.config.ts.\n\nError: P1001\n\nCan't reach database server at \`localhost:1\`\n\nPlease make sure your database server is running at \`localhost:1\`.\n${BOX}`;

const LOCAL_MISMATCH =
    'DATABASE_URL (localhost:5440) reaches a different Postgres than the compose service "postgres", so migrating would write to the wrong database. ' +
    "Something else holds that port on this machine — an intentic sandbox's mirrored port can (intentic-machine sync mirror ignore --sandbox <id> --port 5440). " +
    "See who: ss -ltnp | grep :5440 (Linux), lsof -iTCP:5440 -sTCP:LISTEN (macOS).";

test("the compose service's answer is read as an integer kept in digits, and anything else is no identifier", () => {
    assert.equal(parseSystemIdentifier(`${IDENTIFIER}\n`), IDENTIFIER);
    assert.equal(parseSystemIdentifier("-1234567890123456789\n"), "-1234567890123456789");
    for (const output of ["", "\n", "abc", "12.5", "0x1f", "- 1", `${IDENTIFIER}\n${IDENTIFIER}\n`, 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed']) {
        assert.equal(parseSystemIdentifier(output), undefined, JSON.stringify(output));
    }
});

test("the probe raises its verdict both ways, and nothing but an integer is spliced into it", () => {
    assert.equal(
        sameClusterSql(IDENTIFIER),
        "DO $$ BEGIN IF (SELECT system_identifier FROM pg_control_system()) = 7663961090417463335 " +
            "THEN RAISE EXCEPTION 'verify-target: same cluster'; ELSE RAISE EXCEPTION 'verify-target: different cluster'; END IF; END $$;",
    );
    assert.throws(() => sameClusterSql("1; DROP TABLE users"), { message: 'verify-target: "1; DROP TABLE users" is not a system identifier' });
    assert.throws(() => sameClusterSql(""), { message: 'verify-target: "" is not a system identifier' });
});

test("DATABASE_URL is named by host and port only, with libpq's port when it names none", () => {
    assert.deepEqual(targetOf("postgresql://app:app@localhost:5440/app"), { target: LOCAL });
    assert.deepEqual(targetOf("postgresql://app:app@[::1]:5440/app"), { target: { host: "[::1]", port: "5440" } });
    assert.deepEqual(targetOf("postgresql://app:app@db.example.com/app"), { target: { host: "db.example.com", port: "5432" } });
});

test("an unset DATABASE_URL, or one that names no host, is refused before anything is asked", () => {
    const unset = {
        refusal: "DATABASE_URL is set in neither the environment nor the root .env, so there is no database to migrate: copy .env.example to .env.",
    };
    assert.deepEqual(targetOf(undefined), unset);
    assert.deepEqual(targetOf(""), unset);
    const hostless = {
        refusal: "DATABASE_URL is not a URL that names a host, so there is no database to check; .env.example has the one that reaches the compose service.",
    };
    assert.deepEqual(targetOf("not a url"), hostless);
    assert.deepEqual(targetOf("localhost:5440"), hostless);
});

test("a mismatch on this machine names the port's possible holder and how to see it; one on another host does not", () => {
    assert.equal(mismatchMessage(LOCAL), LOCAL_MISMATCH);
    assert.equal(
        mismatchMessage({ host: "127.0.0.1", port: "6543" }),
        'DATABASE_URL (127.0.0.1:6543) reaches a different Postgres than the compose service "postgres", so migrating would write to the wrong database. ' +
            "Something else holds that port on this machine — an intentic sandbox's mirrored port can (intentic-machine sync mirror ignore --sandbox <id> --port 6543). " +
            "See who: ss -ltnp | grep :6543 (Linux), lsof -iTCP:6543 -sTCP:LISTEN (macOS).",
    );
    assert.equal(
        mismatchMessage({ host: "db.example.com", port: "5432" }),
        'DATABASE_URL (db.example.com:5432) reaches a different Postgres than the compose service "postgres", so migrating would write to the wrong database. ' +
            "db:up and db:reset migrate only the compose service's own; .env.example has the DATABASE_URL that reaches it.",
    );
});

test("the compose service answers with its identifier, or the refusal says what docker said", () => {
    assert.deepEqual(composeIdentity({ code: 0, stdout: `${IDENTIFIER}\n`, stderr: "" }), { identifier: IDENTIFIER });
    const refused = (said) => ({
        refusal: `could not read the compose service "postgres"'s cluster identity, so there is nothing to hold DATABASE_URL against (${said}). docker compose ps postgres says whether it is running.`,
    });
    assert.deepEqual(composeIdentity({ code: 1, stdout: "", stderr: 'service "postgres" is not running\n' }), refused('service "postgres" is not running'));
    assert.deepEqual(composeIdentity({ code: 127, stdout: "", stderr: "docker: spawnSync docker ENOENT" }), refused("docker: spawnSync docker ENOENT"));
    assert.deepEqual(composeIdentity({ code: 1, stdout: "", stderr: "" }), refused("exit 1"));
    assert.deepEqual(composeIdentity({ code: 0, stdout: "app\n", stderr: "" }), refused('it printed "app"'));
});

test("the probe passes on the compose cluster's answer only, names a mismatch, and quotes Prisma without pnpm's box otherwise", () => {
    assert.equal(probeRefusal(raised("same cluster"), LOCAL), undefined);
    assert.equal(probeRefusal(raised("different cluster"), LOCAL), LOCAL_MISMATCH);
    // A script that never reached Prisma runs as an empty one, which exits 0: no answer, so no pass.
    assert.equal(
        probeRefusal(EMPTY_SCRIPT, LOCAL),
        'could not ask the database at DATABASE_URL (localhost:5440) which Postgres it is, so nothing shows it is the compose service "postgres": ' +
            "it exited 0 without either answer, so the script never reached the database",
    );
    const said = "Error: P1001 Can't reach database server at `localhost:1` Please make sure your database server is running at `localhost:1`.";
    assert.equal(prismaSaid(UNREACHABLE), said);
    assert.equal(
        probeRefusal({ code: 1, stdout: "", stderr: UNREACHABLE }, { host: "localhost", port: "1" }),
        `could not ask the database at DATABASE_URL (localhost:1) which Postgres it is, so nothing shows it is the compose service "postgres": ${said}`,
    );
    // pnpm 12 prints only its box when the command it was to exec is missing.
    assert.equal(
        probeRefusal({ code: 1, stdout: "", stderr: BOX }, LOCAL),
        'could not ask the database at DATABASE_URL (localhost:5440) which Postgres it is, so nothing shows it is the compose service "postgres": exit 1',
    );
});
