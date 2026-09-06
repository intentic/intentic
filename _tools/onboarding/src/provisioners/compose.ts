import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAnnounce } from "../announce.js";
import type { Provisioner, ProvisionContext } from "../provisioner.js";
import { copyBlockFor, openRunTab } from "../run-step.js";
import { sh } from "../shell.js";

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

/* Read a copy button's payload. The label sits beside the button in the same block, which is how the two
 * blocks on this tab are told apart, they are otherwise identical widgets (run-step.ts holds the locator and
 * the account of why it names the button as well as the label). */
const copiedText = async (context: ProvisionContext, label: string): Promise<string> => {
    const block = copyBlockFor(context.page, label);
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
             * it, so the RUN step is what this waits for — behind the fold the app-first page puts it, and
             * patiently, both of which run-step.ts owns for the lane beside this one as well. */
            await openRunTab(page, /Docker Compose|^Compose$/u, `Docker Compose`);

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
