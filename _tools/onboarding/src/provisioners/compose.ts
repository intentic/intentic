import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import { expect } from "@playwright/test";
import { PrismaClient } from "@intentic-app/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Provisioner, ProvisionContext } from "../provisioner.js";

/* THE DOCKER COMPOSE PATH, the bytes the wizard renders, run the way a user runs them.
 *
 * Not "call `composeFile()` the way the page calls it". That function already has a unit test
 * (`setupCompose.test.ts`), and a second caller of it would prove the same thing twice while leaving the
 * actual path uncovered: the wizard minting a code, the file it renders being valid compose, the claim
 * redeeming that code into a `.env` the file reads, and the container that comes up announcing itself back.
 * Each of those is a different piece of the product and none of them is a function call.
 *
 * The bytes are taken from the CLIPBOARD, through the page's own copy buttons. That is not a flourish, it is
 * the only way to get exactly what a user would paste, including whatever the copy button decides to put
 * there, rather than a re-derivation that happens to agree today.
 */

const run = promisify(execFile);

/* A FRESH TERMINAL, not this process's environment, and that distinction cost an afternoon.
 *
 * Compose interpolates `${CONNECT_TOKEN}` from the `.env` the claim wrote, but the SHELL's environment
 * outranks that file. This harness runs inside a sandbox that happens to export a `CONNECT_TOKEN` of its own,
 * so compose quietly started the box with somebody else's credential: the container came up perfectly, the
 * platform answered every announce with 404, and nothing anywhere said the word "token".
 *
 * A user pasting these two commands is in a fresh terminal, so that is what they get. The allowlist is what a
 * shell needs to find `curl` and reach Docker, and nothing else, a denylist would only ever be as good as the
 * next variable somebody adds to the compose file.
 */
const PASS_THROUGH = [`PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`, `XDG_RUNTIME_DIR`];

const freshShellEnv = (): Record<string, string> =>
    Object.fromEntries(PASS_THROUGH.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));

/* The platform's registry, polled until it records a daemon, or until the deadline, with what the row DID say
 * so the failure is diagnosable from the log alone. `announceRefusal` is the field that turns "nothing
 * happened" into a sentence: the platform writes the address a daemon claimed when it refuses it. */
const waitForAnnounce = async (databaseUrl: string, since: Date, timeoutMs: number): Promise<void> => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const deadline = Date.now() + timeoutMs;
    try {
        let last = `no sandbox row yet`;
        while (Date.now() < deadline) {
            const rows = await prisma.sandbox.findMany({ select: { id: true, lastSeenAt: true, daemonUrl: true, announceRefusal: true } });
            /* `lastSeenAt` AFTER this run started, not merely present. The announce handler is the only writer
             * of it, but a row can carry an address from the moment it is created, which is how the first
             * version of this wait returned in five seconds, before the container had finished booting. The
             * timestamp is the part no other code path can produce. */
            if (rows.some((row) => row.lastSeenAt !== null && row.lastSeenAt >= since)) {
                return;
            }
            if (rows.length > 0) {
                last = rows
                    .map((row) => `${row.id}: lastSeenAt=${row.lastSeenAt?.toISOString() ?? `never`}, refusal=${JSON.stringify(row.announceRefusal)}`)
                    .join(`; `);
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        }
        throw new Error(`no sandbox announced itself to the platform within ${Math.round(timeoutMs / 1000)}s: ${last}`);
    } finally {
        await prisma.$disconnect();
    }
};

const sh = async (command: string, cwd: string, what: string, timeoutMs = 300_000): Promise<string> => {
    try {
        const { stdout, stderr } = await run(`sh`, [`-c`, command], {
            cwd,
            env: freshShellEnv(),
            timeout: timeoutMs,
            maxBuffer: 32 * 1024 * 1024,
        });
        return `${stdout}${stderr}`;
    } catch (cause) {
        const message = errorMessage(cause);
        throw new Error(`${what} failed: ${message}`, { cause });
    }
};

/* Read a copy button's payload. The label sits beside the button in the same block, which is how the two
 * blocks on this tab are told apart, they are otherwise identical widgets. */
const copiedText = async (context: ProvisionContext, label: string): Promise<string> => {
    const block = context.page.locator(`div`).filter({ hasText: label }).last();
    await block.getByRole(`button`, { name: `Copy` }).click();
    const text = await context.page.evaluate(() => navigator.clipboard.readText());
    if (text.trim() === ``) {
        throw new Error(`the "${label}" block copied nothing: the wizard rendered an empty command`);
    }
    return text;
};

export const composeProvisioner = (): Provisioner => {
    let projectDir: string | undefined;

    return {
        name: `compose`,

        async provision(context) {
            const { page, world } = context;

            await page.goto(`${world.webUrl ?? ``}/setup`);

            /* The wizard opens with step 1 already done, the platform mints the sandbox and its address behind
             * it, so the RUN step is what this waits for, and its tab strip is what it reaches for.
             *
             * Patient on purpose. Step 1 is not instant: a row is created, a reachability grant is minted
             * against the hub, and a setup code is issued, and on a cold world the SPA is still fetching its
             * own chunks while that happens. A minute was enough most of the time, which is the worst amount
             * of time for a gate to allow.
             *
             * Every spelling of the control, because it is a segmented control whose role depends on how it is
             * built, and this tier should fail on the wizard not reaching its run step, not on that detail. */
            const composeTab = page
                .getByRole(`radio`, { name: /Docker Compose|^Compose$/ })
                .or(page.getByRole(`button`, { name: /Docker Compose|^Compose$/ }))
                .or(page.getByRole(`tab`, { name: /Docker Compose|^Compose$/ }))
                .or(page.getByText(`Docker Compose`, { exact: true }));
            await expect(composeTab.first()).toBeVisible({ timeout: 180_000 });
            await composeTab.first().click();

            const yaml = await copiedText(context, `Add these services to your docker-compose.yml`);
            const bootstrap = await copiedText(context, `claim your .env, then start`);

            /* A guard on the ONE thing that silently makes this path untestable: the wizard only points the
             * bootstrap at a local platform when the api is served on localhost, and otherwise renders the
             * hosted default. Running that would redeem this run's setup code against the real platform. */
            if (!bootstrap.includes(world.apiUrl ?? `\u0000`)) {
                throw new Error(
                    `the wizard rendered a bootstrap that does not name this run's platform (${world.apiUrl}): ` +
                        `it points somewhere else, and running it would redeem this setup code against a platform that is not ours. ` +
                        `The wizard only writes a local platform into the command when the api is served on localhost.`,
                );
            }

            // Stamped before the box is started, so the announce this waits for can only be this run's.
            const startedAt = new Date();
            projectDir = await mkdtemp(join(tmpdir(), `intentic-onboarding-compose-`));
            await writeFile(join(projectDir, `docker-compose.yml`), yaml, `utf8`);

            // Exactly the two commands the tab tells the user to run, in the folder holding the file.
            await sh(bootstrap, projectDir, `the compose bootstrap the wizard rendered`, 600_000);

            /* WAIT FOR THE PLATFORM'S REGISTRY, not for words on a screen.
             *
             * The obvious assertion is the wizard's own step 2 advancing, and it was the first thing tried: a
             * regex for "connected" matched `Chat is available once your sandbox is connected.`, copy about
             * the state we were waiting for, and the whole provision went green in seven seconds without a
             * daemon ever having announced. A loose text match on a screen full of sentences about the thing
             * being waited for is a false green waiting to happen.
             *
             * `daemonUrl` on the row is the platform's own record that a daemon reached it and was accepted,
             * which is what "connected" means and is not a phrase anyone can accidentally match. The screen's
             * side of it belongs to the half of the journey that can talk to the box. */
            await waitForAnnounce(world.databaseUrl ?? ``, startedAt, 300_000);
        },

        async teardown() {
            if (projectDir === undefined) {
                return;
            }
            /* `ONBOARDING_KEEP=1` leaves the stack and the folder standing. Debugging this path means reading
             * the `.env` the claim wrote and the daemon's log, and both are gone the instant teardown runs,
             * which is how the first three attempts at it were spent reproducing rather than reading. */
            if (process.env[`ONBOARDING_KEEP`] === `1`) {
                return;
            }
            // `down -v` because the workspace volumes are named and would otherwise outlive every run.
            await sh(`docker compose down -v --remove-orphans`, projectDir, `tearing the compose stack down`, 300_000).catch(() => ``);
            await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
            projectDir = undefined;
        },
    };
};
