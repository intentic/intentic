import type { Page } from "@playwright/test";
import type { WorldFile } from "./world-file.js";

/* THE ONE THING THAT DIFFERS BETWEEN THE FOUR ONBOARDING PATHS.
 *
 * Written out, a user's journey is three segments:
 *
 *   arrive → sign in                    identical everywhere
 *   get a connected sandbox             THE ONLY DIFFERENCE — installer, CLI, compose, cloud
 *   workspace → chat → a reply renders  identical everywhere
 *
 * So this is not four end-to-end tests. It is one journey plus four provisioners behind this interface, which
 * is what makes a path cost one adapter instead of a suite — and what makes a regression in signing in or in
 * chatting fail once rather than four times or, worse, nowhere.
 *
 * `provision` takes the PAGE, because for three of the four paths getting a sandbox is something a user does
 * in the browser: the wizard is where the code is minted and where the command to run is rendered. A
 * provisioner that took only a world would be free to skip the wizard and mint through the api, which would
 * cover our own function instead of the path a person actually walks.
 */
export interface ProvisionContext {
    readonly page: Page;
    readonly world: WorldFile;
}

export interface Provisioner {
    /** Matches the Playwright project name, so a spec finds its own. */
    readonly name: string;
    /** Ends with a sandbox this account owns and the platform considers connected. */
    provision(context: ProvisionContext): Promise<void>;
    /** Never throws. A teardown that fails hides whatever the run was reporting. */
    teardown(): Promise<void>;
}
