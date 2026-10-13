import { join } from "node:path";
import { identityIn } from "../vendor-cli/vendor-cli-identity.js";
import { deviceCodeOf } from "../vendor-cli/vendor-cli-login.js";
import type { VendorCli } from "../vendor-cli/vendor-cli.js";

// xAI's Grok Build CLI (`grok`, Apache-2.0 source at xai-org/grok-build) as the `grok` provider's `vendor` loop. Read off
// 1.0.52 and its source:
// - `grok login --device-auth` runs the device-code flow against accounts.x.ai, prints the page and code on stdout,
//   polls, and writes its session tokens to `$GROK_HOME/auth.json`, which it refreshes itself. xAI decides which
//   accounts may sign in (SuperGrok, X Premium); an account it turns away fails the login with xAI's own sentence.
// - `grok agent stdio` serves ACP from the same home: it signs itself in with the cached token at initialize, offers a
//   `model` option and a `thought_level` option per model, the modes `default`/`plan`/`ask`, session list/load/resume/
//   close, and http/sse MCP.
// `--no-leader` keeps each account's process its own: in leader mode clients share one backend process, and with it one
// sign-in.

export const GROK_BUILD: VendorCli = {
    provider: "grok",
    name: "Grok Build",
    runtime: "grok-build",
    engine: "grok-build",
    door: "grok-build",
    authDir: "grok-build",
    launch: (binary, home) => ({
        argv: [binary, "agent", "--no-leader", "stdio"],
        // GROK_DISABLE_AUTOUPDATER: the engine store's pin is the version that runs.
        env: { GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1" },
        // Its ask-user tool answers through an xAI extension method this client does not speak, so the model would ask
        // nobody; off, the model carries on with what it has (capability record GROK_BUILD: questions false).
        sessionMeta: { askUserQuestion: false },
    }),
    login: {
        argv: (binary) => [binary, "login", "--device-auth"],
        env: (home) => ({ GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1" }),
        deviceCode: deviceCodeOf,
    },
    identity: (home) => identityIn([join(home, "auth.json")]),
};
