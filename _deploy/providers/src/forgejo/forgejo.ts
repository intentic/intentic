import { HOST_STATE_ROOT } from "@intentic/constants";
import { pollUntil, type Provider, type ResolvedInputs } from "@intentic/engine";
import { HASH_KEY } from "@intentic/graph";
import { z } from "zod";
import { guardedUpdate } from "../core/guarded-update.js";
import { hasPendingRef, parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import { listStampedContainers } from "../core/list-stamped.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

const forgejoSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    // The fully-pinned image (repo:tag@sha256) the resolver records in the desired-state graph. read observes
    // the running container's image and diff recreates on a mismatch, so a version bump rolls forward.
    image: z.string(),
    // Guarded-update inputs, present only when the host opted into updatePolicy:"guarded" + declared a backup.
    // A version bump then snapshots the data volume, recreates, health-gates, and rolls image + data back on
    // failure. The restic password/creds come from the on-host restic.env the backup provider writes.
    guardRepo: z.string().optional(),
    resticImage: z.string().optional(),
});
type ForgejoInputs = z.infer<typeof forgejoSchema>;
const parse = (inputs: ResolvedInputs): ForgejoInputs => parseInputs(forgejoSchema, inputs, "forgejo");

const CONTAINER = "intentic-forgejo";
// The fixed host port Forgejo publishes, the port every engine-side Forgejo consumer forwards to over SSH.
export const FORGEJO_HTTP_PORT = 3000;
// The runner registration token + a scoped git access token + a packages access token are minted once and
// persisted on the host, then read back every run, so they are STABLE outputs (re-minting would rotate them,
// breaking the stateless contract). The git token is what Komodo authenticates with to clone the admin's
// private app repos; the packages token is what the Forgejo Action pushes images with and Komodo pulls with.
const STATE_DIR = `${HOST_STATE_ROOT}/forgejo`;
const TOKEN_FILE = `${STATE_DIR}/runner-token`;
const GIT_TOKEN_FILE = `${STATE_DIR}/git-token`;
const PKG_TOKEN_FILE = `${STATE_DIR}/packages-token`;
const READY_TIMEOUT_MS = 120_000;
const READY_INTERVAL_MS = 3_000;

const internalUrl = (parsed: ForgejoInputs): string => `http://${parsed.internalIp}:${FORGEJO_HTTP_PORT}`;
const outputsFor = (parsed: ForgejoInputs, runnerToken: string, gitToken: string, packagesToken: string): Record<string, unknown> => ({
    url: `https://${parsed.domain}`,
    internalUrl: internalUrl(parsed),
    runnerToken,
    gitToken,
    packagesToken,
});

const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}'`);
    return result.stdout.trim() === CONTAINER;
};

// The image reference the running container was created with (the exact repo:tag@sha256 string), so diff can
// compare it against the desired pin and recreate on a version bump.
const runningImage = async (session: SshSession): Promise<string> => {
    const result = await session.exec(`docker inspect --format '{{.Config.Image}}' ${CONTAINER} 2>/dev/null || true`);
    return result.stdout.trim();
};

const healthy = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker exec ${CONTAINER} wget -q -T 10 --spider http://localhost:${FORGEJO_HTTP_PORT}/api/healthz`);
    return result.code === 0;
};

const persisted = async (session: SshSession, file: string): Promise<string> => {
    const result = await session.exec(`cat ${file} 2>/dev/null || true`);
    return result.stdout.trim();
};

const waitHealthy = async (session: SshSession): Promise<void> => {
    if (!(await pollUntil(() => healthy(session), { timeoutMs: READY_TIMEOUT_MS, intervalMs: READY_INTERVAL_MS }))) {
        throw new Error(`forgejo did not become healthy within ${READY_TIMEOUT_MS}ms`);
    }
};

// Forgejo (Git + CI) running on the host as a single SQLite-backed container, with an admin user and a
// persisted runner-registration token. read returns the resource only when the container is up, healthy,
// and the token is persisted (so a noop re-derives a stable output set); diff is a noop because the only
// reconciled state is "running + healthy", which read already gates. apply is idempotent: the SQLite data
// lives in a named volume that survives container recreation, and the admin/token bootstraps are guarded.
export const createForgejoProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A dependency of these $ref inputs is still a pending create (plan resolves leniently),
        // the resource cannot be introspected yet; parsing would crash on the PENDING symbol.
        if (hasPendingRef(inputs, "internalIp")) {
            return undefined;
        }
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`forgejo "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session)) || !(await healthy(session))) {
                return undefined;
            }
            const runnerToken = await persisted(session, TOKEN_FILE);
            const gitToken = await persisted(session, GIT_TOKEN_FILE);
            const packagesToken = await persisted(session, PKG_TOKEN_FILE);
            if (runnerToken === "" || gitToken === "" || packagesToken === "") {
                return undefined;
            }
            const stampHash = (
                await session.exec(`docker inspect --format ${shellQuote(`{{index .Config.Labels "${HASH_KEY}"}}`)} ${CONTAINER}`)
            ).stdout.trim();
            return {
                outputs: outputsFor(parsed, runnerToken, gitToken, packagesToken),
                detail: { image: await runningImage(session) },
                ...(stampHash === "" ? {} : { stampHash }),
            };
        } finally {
            await session.dispose();
        }
    },
    // The SQLite data volume + host token files survive the rm/run recreation in apply, so a version bump is a
    // safe in-place update: recreate on the new image, then the readiness gate re-checks health.
    diff: (inputs, observed) => {
        const desired = parse(inputs).image;
        if (observed.detail?.["image"] !== desired) {
            return { action: "update", reason: `forgejo image differs (running ${String(observed.detail?.["image"])}, want ${desired})` };
        }
        return { action: "noop" };
    },
    apply: async (inputs, observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await session.exec(`mkdir -p ${STATE_DIR}`);
            // (Re)create the container on a given image and wait for health; throws if it never gets healthy.
            const bringUp = async (image: string): Promise<void> => {
                await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
                const run = await session.exec(
                    `docker run -d --restart unless-stopped --network host --name ${CONTAINER} --label intentic.id=${ctx.id} --label intentic.type=forgejo --label intentic.hash=${ctx.inputsHash ?? ""} ` +
                        `-v ${CONTAINER}-data:/data ` +
                        `-e FORGEJO__security__INSTALL_LOCK=true -e FORGEJO__database__DB_TYPE=sqlite3 ` +
                        `-e FORGEJO__server__ROOT_URL=https://${parsed.domain} -e FORGEJO__server__DOMAIN=${parsed.domain} ${image}`,
                );
                if (run.code !== 0) {
                    throw new Error(`failed to start forgejo on host: exited ${run.code}: ${run.stderr.trim()}`);
                }
                await waitHealthy(session);
            };
            // On a guarded version bump (existing container + a backup repo), wrap the recreate in a snapshot +
            // health-gate + image/data rollback transaction; otherwise just bring up the desired image.
            const oldImage = observed?.detail?.["image"];
            if (observed !== undefined && parsed.guardRepo !== undefined && parsed.resticImage !== undefined && typeof oldImage === "string") {
                await guardedUpdate({
                    session,
                    repo: parsed.guardRepo,
                    resticImage: parsed.resticImage,
                    volumes: [`${CONTAINER}-data`],
                    tag: `intentic-preupdate-${ctx.id}`,
                    recreate: () => bringUp(parsed.image),
                    stop: async () => {
                        await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
                    },
                    rollback: () => bringUp(oldImage),
                    log: ctx.log,
                });
            } else {
                await bringUp(parsed.image);
            }
            // Idempotent admin bootstrap: tolerate the user already existing, propagate anything else.
            const admin = await session.exec(
                `docker exec -u git ${CONTAINER} forgejo admin user create --admin --username ${parsed.adminUser} ` +
                    `--password ${parsed.adminPassword} --email ${parsed.adminUser}@${parsed.domain}`,
            );
            if (admin.code !== 0 && !admin.stderr.includes("already exists")) {
                throw new Error(`failed to create forgejo admin: exited ${admin.code}: ${admin.stderr.trim()}`);
            }
            // Mint the runner + git + packages tokens only once; reuse the persisted ones on later applies so outputs stay stable.
            await session.exec(`test -f ${TOKEN_FILE} || docker exec -u git ${CONTAINER} forgejo actions generate-runner-token > ${TOKEN_FILE}`);
            await session.exec(
                `test -f ${GIT_TOKEN_FILE} || docker exec -u git ${CONTAINER} forgejo admin user generate-access-token ` +
                    `--username ${parsed.adminUser} --token-name intentic-komodo --scopes read:repository --raw > ${GIT_TOKEN_FILE}`,
            );
            // write:package lets the Forgejo Action push images to the built-in registry; read:package lets Komodo pull them.
            await session.exec(
                `test -f ${PKG_TOKEN_FILE} || docker exec -u git ${CONTAINER} forgejo admin user generate-access-token ` +
                    `--username ${parsed.adminUser} --token-name intentic-packages --scopes write:package,read:package --raw > ${PKG_TOKEN_FILE}`,
            );
            const runnerToken = await persisted(session, TOKEN_FILE);
            const gitToken = await persisted(session, GIT_TOKEN_FILE);
            const packagesToken = await persisted(session, PKG_TOKEN_FILE);
            if (runnerToken === "") {
                throw new Error("forgejo runner token was not persisted");
            }
            if (gitToken === "") {
                throw new Error("forgejo git access token was not persisted");
            }
            if (packagesToken === "") {
                throw new Error("forgejo packages access token was not persisted");
            }
            return outputsFor(parsed, runnerToken, gitToken, packagesToken);
        } finally {
            await session.dispose();
        }
    },
    // Parses only the SSH block, so it works from a removed node's inputs AND a ListedResource's (a host's).
    delete: async (inputs) => {
        const session = await executor.connect(sshTarget(parseInputs(sshSchema, inputs, "forgejo")));
        try {
            // Remove the container, its SQLite data volume, and the host-side token state, a full teardown.
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            await session.exec(`docker volume rm ${CONTAINER}-data 2>/dev/null || true`);
            await session.exec(`rm -rf ${STATE_DIR}`);
        } finally {
            await session.dispose();
        }
    },
    list: (sources, ctx) => listStampedContainers(executor, "forgejo", sources, ctx.log),
});
