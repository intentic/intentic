import { errorMessage } from "@intentic/base/errors";
import { agentException } from "@intentic/local-agent";
import { buildApplication, buildChoiceParser, buildCommand, buildRouteMap, text_en } from "@stricli/core";
import type { CommandContext } from "@stricli/core";
import { askpass } from "./askpass/askpass-run.js";
import { type GitAction, runGitCredential } from "./git-credential/git-credential.js";
import { runNativeHost } from "./native-host/native-host.js";
import { installHere, runServiceHere, runSessionHere, uninstallHere, userIdFits } from "./service/platform.js";
import { KEYRING_VERSION } from "./version.js";

// The intentic-keyring binary: `service run` is the keyring itself, run by the system as an account of its own;
// `session` its hands in a person's session (started at sign-in), which also answers the user's pipe; `askpass` the
// answer to an ssh, sudo or git prompt; `version` what the release build and `intentic-machine keyring upgrade` read.
// Managing the vault is intentic-machine's `keyring` commands, which talk to the session helper over the user's pipe:
// one CLI for a person to learn.

// The per-user keyring that held the vault in a process of the user's own was retired on 2026-10-19: a login entry
// left from before that still runs `serve` is told where the vault went instead.
const serveCommand = buildCommand({
    docs: { brief: "Retired: Passwords runs as a protected service now (intentic-machine keyring setup)" },
    parameters: {},
    func(this: CommandContext) {
        this.process.stderr.write("Passwords runs as a protected service now, not as `serve`: `intentic-machine keyring setup` moves this computer to it.\n");
        process.exitCode = 1;
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

// git's credential helper and the browser's native-messaging host: each reads what its caller sends on standard input.
const readAll = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
};

const gitCredentialCommand = buildCommand({
    docs: { brief: "git's credential helper: get, store or erase an https sign-in (git runs this)" },
    parameters: { flags: {}, positional: { kind: "tuple", parameters: [{ brief: "get, store or erase", parse: buildChoiceParser(["get", "store", "erase"] as const), placeholder: "get|store|erase" }] } },
    async func(this: CommandContext, _flags: Record<string, never>, action: GitAction) {
        const input = await readAll();
        process.exitCode = await runGitCredential(action, { input, write: (text) => this.process.stdout.write(text), warn: (text) => this.process.stderr.write(text) });
    },
});

const nativeHostCommand = buildCommand({
    docs: { brief: "The browser extension's native-messaging host (the browser runs this)" },
    // The browser passes the extension's origin, and on Windows its window's handle: neither is needed.
    parameters: { flags: {}, positional: { kind: "array", parameter: { brief: "What the browser passes", parse: String } } },
    async func(this: CommandContext, _flags: Record<string, never>, ..._passed: string[]) {
        process.exitCode = await runNativeHost({ input: process.stdin, write: (frame) => process.stdout.write(frame) });
    },
});

// The protected service (service/): install and uninstall run as an administrator (UAC on Windows, pkexec on Linux),
// `run` is what the system starts as the service's own account, and `session` is the helper started at sign-in.
const answered = async (stdout: CommandContext["process"]["stdout"], work: () => Promise<object>): Promise<void> => {
    try {
        stdout.write(`${JSON.stringify({ ok: true, ...(await work()) })}\n`);
    } catch (error) {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
    }
};

const installCommand = buildCommand({
    docs: { brief: "Install Passwords' protected service for you, moving a vault from before into it (run as an administrator; intentic-machine keyring setup does this)" },
    parameters: {},
    async func(this: CommandContext) {
        await answered(this.process.stdout, async () => await installHere());
    },
});

const uninstallCommand = buildCommand({
    docs: { brief: "Put the vault back in your own folder and remove Passwords' protected service (run as an administrator)" },
    parameters: {},
    async func(this: CommandContext) {
        await answered(this.process.stdout, async () => await uninstallHere());
    },
});

const runCommand = buildCommand({
    docs: { brief: "Run Passwords' protected service (what the system starts)" },
    parameters: { flags: { user: { kind: "parsed", parse: String, brief: "The user it is for: a security identifier (Windows) or a uid (Linux)" } } },
    async func(this: CommandContext, flags: { readonly user: string }) {
        if (!userIdFits(flags.user)) {
            this.process.stderr.write("--user takes a security identifier (S-1-5-…) on Windows, a numeric uid on Linux.\n");
            process.exitCode = 1;
            return;
        }
        await runServiceHere(flags.user);
    },
});

const sessionCommand = buildCommand({
    docs: { brief: "Run Passwords' session helper (started at sign-in)" },
    parameters: {},
    async func() {
        await runSessionHere();
    },
});

export const app = buildApplication(buildRouteMap({ routes: { serve: serveCommand, version: versionCommand, askpass: askpassCommand, "git-credential": gitCredentialCommand, "native-host": nativeHostCommand, service: buildRouteMap({ routes: { install: installCommand, uninstall: uninstallCommand, run: runCommand }, docs: { brief: "Passwords' protected service" } }), session: sessionCommand }, docs: { brief: "The Intentic keyring" } }), {
    name: "intentic-keyring",
    versionInfo: { currentVersion: KEYRING_VERSION },
    scanner: { caseStyle: "allow-kebab-for-camel" },
    localization: { text: { ...text_en, formatException: agentException, exceptionWhileRunningCommand: (exc) => `error: ${agentException(exc)}` } },
});
