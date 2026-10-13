import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { identityIn } from "../vendor-cli/vendor-cli-identity.js";
import { deviceCodeOf } from "../vendor-cli/vendor-cli-login.js";
import type { VendorCli } from "../vendor-cli/vendor-cli.js";

// Moonshot's Kimi Code CLI (npm @moonshot-ai/kimi-code, MIT) as the `kimi` provider's `vendor` loop. Read off 2.1.1:
// - `kimi login` runs the device-code flow (auth.kimi.com, the region the CLI picks by default, the same estate the
//   translator's Kimi sign-in reaches), prints the page and code on stderr, polls, and writes its OAuth tokens under
//   `$KIMI_CODE_HOME/credentials/`, which it refreshes itself.
// - `kimi acp` serves ACP over stdio from the same home: session list/load/resume/fork/close/delete, a `model` option, a
//   `thinking` option in the `thought_level` category, the modes `default`/`plan`/`auto`/`yolo`, form elicitation for
//   its ask-user tool, and http/sse MCP.
// The client identifier stays the CLI's own: Kimi warns that tampering with it can suspend an account, so nothing here
// sets one.

export const KIMI_CLI: VendorCli = {
    provider: "kimi",
    name: "Kimi CLI",
    runtime: "kimi-cli",
    engine: "kimi",
    door: "kimi-cli",
    authDir: "kimi-cli",
    // KIMI_CODE_NO_AUTO_UPDATE: the engine store's pin is the version that runs, not whatever the CLI would fetch itself.
    launch: (binary, home) => ({ argv: [binary, "acp"], env: { KIMI_CODE_HOME: home, KIMI_CODE_NO_AUTO_UPDATE: "1" } }),
    login: {
        argv: (binary) => [binary, "login"],
        env: (home) => ({ KIMI_CODE_HOME: home, KIMI_CODE_NO_AUTO_UPDATE: "1" }),
        deviceCode: deviceCodeOf,
    },
    identity: async (home) => {
        const dir = join(home, "credentials");
        const files = ((await readdir(dir).catch(undefinedIfMissing)) ?? []).filter((name) => name.endsWith(".json")).toSorted();
        return identityIn(files.map((name) => join(dir, name)));
    },
};
