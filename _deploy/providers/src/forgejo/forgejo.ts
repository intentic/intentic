import { HOST_STATE_ROOT } from "@intentic/constants";
import { pollUntil } from "@intentic/base/async";
import type { Provider, ResolvedInputs } from "@intentic/engine";
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
    // Fully-pinned image (repo:tag@sha256); diff recreates the container on a mismatch.
    image: z.string(),
    // Guarded-update inputs, present only under updatePolicy:"guarded" with a backup.
    guardRepo: z.string().optional(),
    resticImage: z.string().optional(),
});
type ForgejoInputs = z.infer<typeof forgejoSchema>;
const parse = (inputs: ResolvedInputs): ForgejoInputs => parseInputs(forgejoSchema, inputs, "forgejo");

const CONTAINER = "intentic-forgejo";
// Fixed host port Forgejo publishes; every consumer forwards to it over SSH.
export const FORGEJO_HTTP_PORT = 3000;
// Tokens are minted once, persisted on the host, and read back every run; re-minting would rotate them.
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

// Image reference the running container was created with, compared against the desired pin by diff.
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

// Forgejo (Git + CI) on the host, single SQLite-backed container with an admin user and persisted tokens. `read`
// gates on container up + healthy + tokens persisted; the SQLite volume and guarded bootstraps make apply idempotent.
export const createForgejoProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        // A pending dependency means this resource cannot be introspected yet; parsing would crash on the symbol.
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
    // SQLite data and token files survive apply's rm/run recreation, so a version bump is a safe in-place update.
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
            // (Re)creates the container on a given image and waits for health; throws if it never becomes healthy.
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
            // A guarded version bump wraps recreate in a snapshot + health-gate + rollback transaction.
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
            // Mints the runner/git/packages tokens once; later applies reuse the persisted ones.
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
    // Parses only the SSH block, so it works from a removed node's inputs or a ListedResource's.
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
