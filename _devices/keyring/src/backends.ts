import type { BackendConfig, BackendRef } from "./protocol.js";
import { firstLineScrubbed, type RunAnswer, type Runner, type RunRequest, succeeded } from "./run.js";

// A BACKED ENTRY's value is read from its password manager at each use, through that manager's own CLI: 1Password
// (`op read`), Bitwarden (`bw get`) or KeePassXC (`keepassxc-cli show`). What unlocks the manager (a service-account
// token, a master password, a database password) is another entry of this vault, and reaches the CLI in its environment
// or on its standard input, never on its command line. A CLI that fails is a refusal with its own first line of
// complaint, every secret it was handed blanked out of it.

const TIMEOUT_MS = 20_000;

export type BackendRead = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly code: "unavailable"; readonly reason: string };

// What a backend may read of the vault: another entry's value, by name, for the token or password that unlocks it.
export type SecretOf = (name: string) => Promise<string | undefined>;

// What a CLI printed, without the one line break it ends a value with.
const valueOf = (answer: RunAnswer): string => answer.stdout.replace(/\r?\n$/u, "");

const unavailable = (reason: string): BackendRead => ({ ok: false, code: "unavailable", reason });

const failure = (manager: string, cli: string, answer: RunAnswer, secrets: readonly string[]): BackendRead => {
    if (answer.missing) {
        return unavailable(`${manager}'s CLI (${cli}) is not installed, or not on this keyring's PATH.`);
    }
    if (answer.timedOut) {
        return unavailable(`${manager} did not answer within ${String(TIMEOUT_MS / 1000)} s.`);
    }
    const said = firstLineScrubbed(answer.stderr, secrets);
    return unavailable(`${manager} did not answer${said === "" ? "" : `: ${said}`}`);
};

export class BackendReader {
    // Bitwarden's session key from the last unlock, kept until the vault locks: `bw unlock` takes seconds.
    #bitwardenSession: string | undefined;

    constructor(private readonly runner: Runner) {}

    // Forgets every session a manager handed out, as the vault locks.
    forget(): void {
        this.#bitwardenSession = undefined;
    }

    async read(ref: BackendRef, configs: readonly BackendConfig[], secretOf: SecretOf): Promise<BackendRead> {
        switch (ref.backend) {
            case "1password":
                return await this.#onePassword(ref.ref, configs.find((config) => config.backend === "1password"), secretOf);
            case "bitwarden": {
                const config = configs.find((candidate) => candidate.backend === "bitwarden");
                return config?.backend === "bitwarden"
                    ? await this.#bitwarden(ref.ref, ref.field, config, secretOf)
                    : unavailable("Bitwarden is not set up in this keyring: `intentic-machine keyring backend bitwarden` names the entry holding its master password.");
            }
            case "keepassxc": {
                const config = configs.find((candidate) => candidate.backend === "keepassxc");
                return config?.backend === "keepassxc"
                    ? await this.#keepass(ref.ref, ref.attribute, config, secretOf)
                    : unavailable("KeePassXC is not set up in this keyring: `intentic-machine keyring backend keepassxc` names its database and the entry holding its password.");
            }
        }
    }

    // `op read`, unlocked by the 1Password app's own prompt, or by a service-account token kept as another entry.
    async #onePassword(ref: string, config: BackendConfig | undefined, secretOf: SecretOf): Promise<BackendRead> {
        const settings = config?.backend === "1password" ? config : undefined;
        const cli = settings?.cli ?? "op";
        let token: string | undefined;
        if (settings?.tokenEntry !== undefined) {
            token = await secretOf(settings.tokenEntry);
            if (token === undefined) {
                return unavailable(`The entry ${settings.tokenEntry}, which holds the 1Password token, is not in this keyring.`);
            }
        }
        const args = [...(settings?.account === undefined ? [] : ["--account", settings.account]), "read", "--no-newline", ref];
        const request: RunRequest =
            token === undefined ? { command: cli, args, timeoutMs: TIMEOUT_MS } : { command: cli, args, env: { OP_SERVICE_ACCOUNT_TOKEN: token }, timeoutMs: TIMEOUT_MS };
        const answer = await this.runner(request);
        return succeeded(answer) ? { ok: true, value: valueOf(answer) } : failure("1Password", cli, answer, token === undefined ? [] : [token]);
    }

    // `bw unlock` with the master password in its environment, then `bw get` with the session in BW_SESSION.
    async #bitwarden(ref: string, field: string, config: Extract<BackendConfig, { readonly backend: "bitwarden" }>, secretOf: SecretOf): Promise<BackendRead> {
        const password = await secretOf(config.passwordEntry);
        if (password === undefined) {
            return unavailable(`The entry ${config.passwordEntry}, which holds the Bitwarden master password, is not in this keyring.`);
        }
        for (const fresh of [false, true]) {
            if (fresh || this.#bitwardenSession === undefined) {
                const unlocked = await this.runner({
                    command: config.cli,
                    args: ["unlock", "--passwordenv", "INTENTIC_BW_PASSWORD", "--raw"],
                    env: { INTENTIC_BW_PASSWORD: password },
                    timeoutMs: TIMEOUT_MS,
                });
                const session = unlocked.stdout.trim();
                if (!succeeded(unlocked) || session === "") {
                    return failure("Bitwarden", config.cli, unlocked, [password, session]);
                }
                this.#bitwardenSession = session;
            }
            const session = this.#bitwardenSession;
            const answer = await this.runner({ command: config.cli, args: ["get", field, ref], env: { BW_SESSION: session }, timeoutMs: TIMEOUT_MS });
            if (succeeded(answer)) {
                return { ok: true, value: valueOf(answer) };
            }
            // A session the vault has since ended is worth one fresh unlock; any other failure is the answer.
            if (fresh || answer.missing || answer.timedOut || !/session|locked|unlock/iu.test(answer.stderr)) {
                return failure("Bitwarden", config.cli, answer, [password, session]);
            }
        }
        return unavailable("Bitwarden did not answer.");
    }

    // `keepassxc-cli show`, the database password on its standard input.
    async #keepass(ref: string, attribute: string, config: Extract<BackendConfig, { readonly backend: "keepassxc" }>, secretOf: SecretOf): Promise<BackendRead> {
        const password = await secretOf(config.passwordEntry);
        if (password === undefined) {
            return unavailable(`The entry ${config.passwordEntry}, which holds the KeePassXC database password, is not in this keyring.`);
        }
        const args = ["show", "-q", "-s", "-a", attribute, ...(config.keyFile === undefined ? [] : ["-k", config.keyFile]), config.database, ref];
        const answer = await this.runner({ command: config.cli, args, input: `${password}\n`, timeoutMs: TIMEOUT_MS });
        return succeeded(answer) ? { ok: true, value: valueOf(answer) } : failure("KeePassXC", config.cli, answer, [password]);
    }
}
