import type { RunningSandbox } from "@intentic/sandbox-contract/state/sandbox-build";
import type { Config } from "../env.config.js";
import { opt } from "../opt.js";
import { bootedAt, version } from "../version.js";
import { runningBuild } from "./overlay.js";

// This sandbox's identity for the Connections card and /info.
export interface SandboxInfo {
    readonly name: string;
    readonly image: string;
    readonly version: string;
    // Release channel and rollback image, runner-set env; absent if predating channels or never swapped.
    readonly channel?: string;
    readonly previousImage?: string;
    // What answers: the build this container runs and when its daemon started, for a page following a swap.
    readonly running?: RunningSandbox;
}

// Undefined outside a named, imaged sandbox (loopback, tests), where /info returns {}.
export const sandboxInfoOf = (config: Config): SandboxInfo | undefined =>
    config.sandbox.name !== "" && config.sandbox.image !== ""
        ? {
              name: config.sandbox.name,
              image: config.sandbox.image,
              version,
              // Empty means not set, never a value to publish; "" would be an unclickable rollback button.
              ...opt("channel", config.sandbox.channel === "" ? undefined : config.sandbox.channel),
              ...opt("previousImage", config.sandbox.previousImage === "" ? undefined : config.sandbox.previousImage),
              running: { build: runningBuild(config.sandbox), bootedAt },
          }
        : undefined;
