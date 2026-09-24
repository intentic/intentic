import { basename } from "node:path";
import { HOST_STATE_ROOT } from "@intentic/constants";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { dockerEnvLine, shellQuote } from "@intentic/sandbox-run/quote";
import { z } from "zod";
import { execChecked, writeHostFiles } from "../core/host-files.js";
import { parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

// Secrets arrive already resolved to strings. retention/schedule carry the resolver-or-default cron + keep
// counts; signoz opts the observability volumes into the backup set.
const backupSchema = sshSchema.extend({
    repo: z.string(),
    password: z.string(),
    image: z.string(),
    signoz: z.coerce.boolean().default(false),
    credentials: z.record(z.string(), z.string()).default({}),
    // Exactly five cron fields, by shape not escaping: a crontab can't quote a 6th field or a newline entry.
    schedule: z
        .string()
        .regex(/^[\d*,/A-Za-z-]+(?: [\d*,/A-Za-z-]+){4}$/, "must be exactly five cron fields (minute hour day month weekday)")
        .default("0 3 * * *"),
    // WHICH CLOCK `schedule` IS READ ON. A cron in a crontab means nothing without one, and crond takes the zone
    // from the container's own environment, which is UTC unless told otherwise. That default is a fine answer — a
    // backup at 03:00 UTC every day is stable and never skips or repeats an hour at a changeover, unlike a local
    // 03:00 — but it has to be a STATED answer, or an operator reading "0 3 * * *" reads their own 3am.
    // A named zone also needs tzdata present in `image`; without it crond silently falls back to UTC, which is why
    // UTC is the default rather than something derived from the host.
    timezone: z.string().default("UTC"),
    retention: z
        .object({ daily: z.coerce.number().default(7), weekly: z.coerce.number().default(4), monthly: z.coerce.number().default(6) })
        .default({ daily: 7, weekly: 4, monthly: 6 }),
});
type BackupInputs = z.infer<typeof backupSchema>;
// The same test `@intentic/sandbox-contract`'s `isZone` makes, spelled locally: the deploy plane is bundled on its
// own and does not carry the sandbox contract, and one predicate is not worth the edge between them. An offset
// ("+02:00") is refused for the reason it is refused everywhere here — it cannot express a summer-time rule.
const knownZone = (value: string): boolean => {
    if (value.startsWith("+") || value.startsWith("-")) {
        return false;
    }
    try {
        return Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone !== "";
    } catch {
        return false;
    }
};

const parse = (inputs: ResolvedInputs): BackupInputs => {
    const parsed = parseInputs(backupSchema, inputs, "backup");
    // Refused at parse rather than at the crontab: a zone crond cannot resolve does not fail, it silently runs the
    // backup in UTC, and the operator finds out by reading snapshot timestamps months later.
    if (!knownZone(parsed.timezone)) {
        throw new Error(`backup: "${parsed.timezone}" is not a zone name this machine knows (try Europe/Warsaw, or UTC)`);
    }
    return parsed;
};

const CONTAINER = "intentic-backup";
const STATE_DIR = `${HOST_STATE_ROOT}/backup`;
const ENV_FILE = `${STATE_DIR}/restic.env`;
const SCRIPT_FILE = `${STATE_DIR}/backup.sh`;
const CRONTAB_FILE = `${STATE_DIR}/crontab`;
// Inspecting labels (set at create time) is the observable source of truth for schedule + repo.
const SEP = "|";

// A repo path starting with "/" is a local restic repo; one with a scheme (s3:/b2:/rest:/sftp:) is remote.
export const REPO_VOLUME = "intentic-restic-repo";
export const isLocalRepo = (repo: string): boolean => repo.startsWith("/");

// The volumes backed up, host volume name -> in-container mount path. SignOz's (large, reconstructable) volumes
// are added only when opted in.
const volumeMounts = (signoz: boolean): Record<string, string> => ({
    "intentic-forgejo-data": "/volumes/forgejo",
    "komodo_postgres-data": "/volumes/komodo-postgres",
    komodo_keys: "/volumes/komodo-keys",
    "komodo_ferretdb-state": "/volumes/komodo-ferretdb",
    ...(signoz ? { "signoz_clickhouse-data": "/volumes/signoz-clickhouse", "signoz_signoz-data": "/volumes/signoz-signoz" } : {}),
});

// The backup script crond runs each tick, inside the restic container. App-consistent dumps first (best-effort,
// falling back to the volume backup), then one restic snapshot, then a retention prune. Written under a quoted
// heredoc so the host shell does not expand the script's own $vars.
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
        // The on-host default repo is intentic-owned, so self-init it on first use (idempotent). A remote repo is the
        // operator's, left as-is.
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

// The create-time image + the schedule/repo labels, the observable config the diff converges on.
const observe = async (session: SshSession): Promise<{ image: string; schedule: string; repo: string; timezone: string }> => {
    const result = await session.exec(
        `docker inspect --format '{{.Config.Image}}${SEP}{{index .Config.Labels "intentic.schedule"}}${SEP}{{index .Config.Labels "intentic.repo"}}${SEP}{{index .Config.Labels "intentic.timezone"}}' ${CONTAINER} 2>/dev/null || true`,
    );
    // A container created before the zone was recorded reports an empty one, which reads as the UTC it was in fact
    // running on, so it converges on the first apply rather than looking like a change nobody made.
    const [image = "", schedule = "", repo = "", timezone = ""] = result.stdout.trim().split(SEP);
    return { image, schedule, repo, timezone: timezone === "" ? "UTC" : timezone };
};

// Write restic.env once (the encryption password + backend creds must survive recreation); always rewrite the
// script + crontab so a schedule/repo/retention change reconciles. Every write is checked: a failed one would leave
// crond running a stale or empty script behind a container reported applied.
const ensureFiles = async (session: SshSession, parsed: BackupInputs): Promise<void> => {
    await writeHostFiles(session, "backup", STATE_DIR, {
        [basename(SCRIPT_FILE)]: backupScript(parsed),
        [basename(CRONTAB_FILE)]: `${parsed.schedule} /bin/sh ${SCRIPT_FILE}\n`,
    });
    await execChecked(session, "backup", `chmod +x ${SCRIPT_FILE}`, `chmod ${SCRIPT_FILE}`);
    // dockerEnvLine renders the file's line; shellQuote carries it through the host shell as one printf argument.
    const envLines = [
        dockerEnvLine("RESTIC_PASSWORD", parsed.password),
        ...Object.entries(parsed.credentials).map(([key, value]) => dockerEnvLine(key, value)),
    ]
        .map((line) => shellQuote(line))
        .join(" ");
    await execChecked(
        session,
        "backup",
        `test -f ${ENV_FILE} || { printf '%s' ${envLines} > ${ENV_FILE} && chmod 600 ${ENV_FILE}; }`,
        `write ${ENV_FILE}`,
    );
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

// The scheduled restic backup for a host: a container running busybox crond that dumps Forgejo + Komodo (and
// SignOz when opted in) to the operator's restic repo. delete never touches the restic repo.
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
            // observe is a safe `|| true`'d inspect; run alongside running() and discarded when the container isn't up.
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
        // Same hour on a different clock is a different moment, so this converges like any other config change.
        if (detail["timezone"] !== parsed.timezone) {
            return { action: "update", reason: `backup timezone differs (running ${String(detail["timezone"])}, want ${parsed.timezone})` };
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            // The restic image carries no docker CLI; bind-mount the host's static binary so dump steps can `docker
            // exec`.
            const dockerBin = (await session.exec("command -v docker")).stdout.trim();
            if (dockerBin === "") {
                throw new Error("backup: no docker CLI found on the host (the backup container needs it for app-consistent dumps)");
            }
            await ensureFiles(session, parsed);
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            const run = await session.exec(
                `docker run -d --restart unless-stopped --name ${CONTAINER} --label ${shellQuote(`intentic.id=${ctx.id}`)} --label intentic.type=backup ` +
                    `--label ${shellQuote(`intentic.schedule=${parsed.schedule}`)} --label ${shellQuote(`intentic.repo=${parsed.repo}`)} ` +
                    `--label ${shellQuote(`intentic.timezone=${parsed.timezone}`)} -e ${shellQuote(`TZ=${parsed.timezone}`)} ` +
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
            // Removes the scheduler + host-side script/secret state; the restic repo and its snapshots are left
            // untouched.
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            await session.exec(`rm -rf ${STATE_DIR}`);
            ctx.log(`backup "${ctx.id}" removed; the restic repo and its snapshots are left untouched`);
        } finally {
            await session.dispose();
        }
    },
    list: (sources, ctx) => listStampedContainers(executor, "backup", sources, ctx.log),
});
