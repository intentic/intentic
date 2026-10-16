import { BackendReader } from "./backends.js";
import type { RunAnswer, RunRequest, Runner } from "./run.js";

const ok = (stdout: string): RunAnswer => ({ exitCode: 0, stdout, stderr: "", timedOut: false, missing: false, startError: undefined });

interface Recording {
    readonly runner: Runner;
    readonly requests: RunRequest[];
}

const recording = (answers: readonly RunAnswer[]): Recording => {
    const requests: RunRequest[] = [];
    let next = 0;
    return {
        requests,
        runner: (request) => {
            requests.push(request);
            return Promise.resolve(answers[next++] ?? ok(""));
        },
    };
};

const secrets = { OP_TOKEN: "ops_service_account_token_value", BW_MASTER: "bitwarden-master-password", KP_PASSWORD: "keepass-database-password" };
const kept = new Map(Object.entries(secrets));
const secretOf = (name: string): Promise<string | undefined> => Promise.resolve(kept.get(name));

// Every secret must reach the CLI on stdin or in its environment, never on its command line.
const argvHoldsNoSecret = (requests: readonly RunRequest[]): void => {
    for (const request of requests) {
        for (const value of [...Object.values(secrets), "bw-session-key-123"]) {
            expect(request.args.join(" ")).not.toContain(value);
        }
    }
};

describe("password managers", () => {
    test("1Password reads with its service-account token in the environment", async () => {
        const { runner, requests } = recording([ok("op-value")]);
        const read = await new BackendReader(runner).read({ backend: "1password", ref: "op://Work/VPN/password" }, [{ backend: "1password", cli: "op", tokenEntry: "OP_TOKEN" }], secretOf);
        expect(read).toEqual({ ok: true, value: "op-value" });
        expect(requests[0]?.env).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: secrets.OP_TOKEN });
        argvHoldsNoSecret(requests);
    });

    test("Bitwarden unlocks with the master password in the environment and reads with the session there too", async () => {
        const { runner, requests } = recording([ok("bw-session-key-123\n"), ok("bw-value\n")]);
        const read = await new BackendReader(runner).read({ backend: "bitwarden", ref: "vpn", field: "password" }, [{ backend: "bitwarden", cli: "bw", passwordEntry: "BW_MASTER" }], secretOf);
        expect(read).toEqual({ ok: true, value: "bw-value" });
        expect(requests[0]?.env).toEqual({ INTENTIC_BW_PASSWORD: secrets.BW_MASTER });
        expect(requests[1]?.env).toEqual({ BW_SESSION: "bw-session-key-123" });
        argvHoldsNoSecret(requests);
    });

    test("KeePassXC gets its database password on standard input", async () => {
        const { runner, requests } = recording([ok("kp-value\n")]);
        const read = await new BackendReader(runner).read(
            { backend: "keepassxc", ref: "Work/VPN", attribute: "Password" },
            [{ backend: "keepassxc", cli: "keepassxc-cli", database: "/home/r/vault.kdbx", passwordEntry: "KP_PASSWORD" }],
            secretOf,
        );
        expect(read).toEqual({ ok: true, value: "kp-value" });
        expect(requests[0]?.input).toBe(`${secrets.KP_PASSWORD}\n`);
        argvHoldsNoSecret(requests);
    });

    test("a CLI that fails is a refusal, and what it echoed of a secret is blanked out", async () => {
        const failed: RunAnswer = { exitCode: 1, stdout: "", stderr: `bad password ${secrets.KP_PASSWORD}\n`, timedOut: false, missing: false, startError: undefined };
        const { runner } = recording([failed]);
        const read = await new BackendReader(runner).read(
            { backend: "keepassxc", ref: "Work/VPN", attribute: "Password" },
            [{ backend: "keepassxc", cli: "keepassxc-cli", database: "/home/r/vault.kdbx", passwordEntry: "KP_PASSWORD" }],
            secretOf,
        );
        expect(read.ok).toBe(false);
        expect(JSON.stringify(read)).not.toContain(secrets.KP_PASSWORD);
    });
});
