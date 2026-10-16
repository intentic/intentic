import { agentException } from "@intentic/local-agent";
import { buildApplication, buildCommand, buildRouteMap, text_en } from "@stricli/core";
import type { CommandContext } from "@stricli/core";
import { askpass } from "./askpass/askpass-run.js";
import { serve } from "./serve.js";
import { runSession } from "./service/helper.js";
import { installService, uninstallService } from "./service/install.js";
import { SID_RE } from "./service/paths.js";
import { runService } from "./service/service-run.js";
import { realRunner } from "./run.js";
import { KEYRING_VERSION } from "./version.js";

// The intentic-keyring binary: `serve` is the resident keyring itself, `askpass` the answer to an ssh, sudo or git
// prompt, `version` what the release build and `intentic-machine keyring upgrade` read. Managing the vault is
// intentic-machine's `keyring` commands, which talk to `serve` over its pipe: one CLI for a person to learn.

const serveCommand = buildCommand({
    docs: { brief: "Run the keyring (started at sign-in; there is one per user)" },
    parameters: {},
    async func(this: CommandContext) {
        const served = await serve();
        if (!served.ok) {
            this.process.stderr.write(`${served.reason}\n`);
            process.exitCode = 1;
            return;
        }
        const stop = (): void => {
            void served.stop().then(() => process.exit(0));
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await new Promise<never>(() => undefined);
    },
});

const versionCommand = buildCommand({
    docs: { brief: "Print this keyring's version" },
    parameters: {},
    func(this: CommandContext) {
        this.process.stdout.write(`${KEYRING_VERSION}\n`);
    },
});

const askpassCommand = buildCommand({
    docs: { brief: "Answer an ssh, sudo or git password prompt from the keyring (what intentic-askpass runs)" },
    parameters: { flags: {}, positional: { kind: "array", parameter: { brief: "The prompt the program showed", parse: String } } },
    async func(this: CommandContext, _flags: Record<string, never>, ...prompt: string[]) {
        process.exitCode = await askpass(prompt.join(" "), this.process.stdout, this.process.stderr);
    },
});

// Hardened mode on Windows (service/): install and uninstall run elevated, `run` is what the startup task starts as
// LOCAL SERVICE, and `session` is the helper started at sign-in in place of `serve`.
const windowsOnly = (): boolean => {
    if (process.platform !== "win32") {
        process.stderr.write("Hardened mode is Windows-only.\n");
        process.exitCode = 1;
        return false;
    }
    return true;
};

const installCommand = buildCommand({
    docs: { brief: "Move the vault under the hardened service (run elevated; intentic-machine keyring harden does this)" },
    parameters: {},
    async func(this: CommandContext) {
        if (windowsOnly()) {
            const done = await installService(realRunner);
            this.process.stdout.write(`${JSON.stringify({ ok: true, ...done })}\n`);
        }
    },
});

const uninstallCommand = buildCommand({
    docs: { brief: "Put the vault back in your own folder and remove the hardened service (run elevated)" },
    parameters: {},
    async func(this: CommandContext) {
        if (windowsOnly()) {
            const done = await uninstallService(realRunner);
            this.process.stdout.write(`${JSON.stringify({ ok: true, ...done })}\n`);
        }
    },
});

const runCommand = buildCommand({
    docs: { brief: "Run the hardened service (what its startup task starts)" },
    parameters: { flags: { user: { kind: "parsed", parse: String, brief: "The user's security identifier" } } },
    async func(this: CommandContext, flags: { readonly user: string }) {
        if (!SID_RE.test(flags.user)) {
            this.process.stderr.write("--user takes a security identifier (S-1-5-…).\n");
            process.exitCode = 1;
            return;
        }
        if (windowsOnly()) {
            await runService(flags.user);
        }
    },
});

const sessionCommand = buildCommand({
    docs: { brief: "Run the session helper of a hardened keyring (started at sign-in)" },
    parameters: {},
    async func() {
        if (windowsOnly()) {
            await runSession();
        }
    },
});

export const app = buildApplication(buildRouteMap({ routes: { serve: serveCommand, version: versionCommand, askpass: askpassCommand, service: buildRouteMap({ routes: { install: installCommand, uninstall: uninstallCommand, run: runCommand }, docs: { brief: "Hardened mode (Windows)" } }), session: sessionCommand }, docs: { brief: "The Intentic keyring" } }), {
    name: "intentic-keyring",
    versionInfo: { currentVersion: KEYRING_VERSION },
    scanner: { caseStyle: "allow-kebab-for-camel" },
    localization: { text: { ...text_en, formatException: agentException, exceptionWhileRunningCommand: (exc) => `error: ${agentException(exc)}` } },
});
