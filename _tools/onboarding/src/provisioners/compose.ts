import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAnnounce } from "../announce.js";
import type { Provisioner, ProvisionContext } from "../provisioner.js";
import { copyBlockFor, openRunTab } from "../run-step.js";
import { sh } from "../shell.js";

// Drives the wizard's rendered path end to end (mint, render, claim redemption, container announce), not
// `composeFile()` directly, which already has a unit test and would leave the real path uncovered. Bytes come from the
// clipboard through the page's own copy buttons, to get exactly what a user would paste, not a re-derivation.

// Reads a copy button's payload; the label beside it is what tells the tab's two otherwise-identical blocks apart.
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

            // Step 1 is already done (sandbox minted); this waits on the RUN step, which the wizard renders behind a
            // fold.
            await openRunTab(page, /Docker Compose|^Compose$/u, `Docker Compose`);

            const yaml = await copiedText(context, `Add these services to your docker-compose.yml`);
            const bootstrap = await copiedText(context, `claim your .env, then start`);

            // Guards the one silent failure: the wizard only targets a local platform when the api is on localhost.
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

            // Waits on the platform's registry (daemonUrl), not wizard screen text, which false-greened in 7s once.
            await waitForAnnounce(world.databaseUrl ?? ``, startedAt, 300_000);
        },

        async teardown() {
            if (projectDir === undefined) {
                return;
            }
            // ONBOARDING_KEEP=1 leaves the stack and folder up, so the .env and daemon log survive for debugging.
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
