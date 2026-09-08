import type { Page } from "@playwright/test";
import type { WorldFile } from "./world-file.js";

// One journey plus a provisioner per path (installer, CLI, compose) behind this interface, so only getting a connected
// sandbox differs; a regression in signing in or chatting fails once, not once per path. `provision` takes the page
// because minting a sandbox happens in the browser wizard, not just via the api.
export interface ProvisionContext {
    readonly page: Page;
    readonly world: WorldFile;
}

export interface Provisioner {
    /** Matches the Playwright project name, so a spec finds its own. */
    readonly name: string;
    // Why this path can't run here, or undefined when it can, asked once before the journey starts; stands the lane
    // down with an actionable sentence, as the world stands the tier down without Docker.
    standDown?(): Promise<string | undefined>;
    /** Ends with a sandbox this account owns and the platform considers connected. */
    provision(context: ProvisionContext): Promise<void>;
    /** Never throws. A teardown that fails hides whatever the run was reporting. */
    teardown(): Promise<void>;
}
