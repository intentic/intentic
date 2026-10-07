import { WORKSPACE_ROOT } from "@intentic/constants";
import { inspectSchema } from "@puristic/env/index.js";
import { REPLAY_ENV, REPLAY_SECRET_ENV } from "@intentic/sandbox-run";
import { CONFIG_SECRET_ENV, CONTAINER_SECRET_ENV, configSchema } from "../env.config.js";
import { containerKeyEnv, resetSealedEnvForTests, sealConfigSecrets, startedEnv } from "./sealed-env.js";

const keys = { claudeCodeOauthToken: "oauth-value", anthropicApiKey: "", openaiApiKey: "openai-value" };

afterEach(() => resetSealedEnvForTests());

describe("the container's secret environment", () => {
    test("names every credential the container can be started with", () => {
        for (const name of [
            "CONNECT_TOKEN",
            "SYNC_PAIR_TOKEN",
            "HOST_PAIR_TOKEN",
            "SANDBOX_GRANT",
            "TRANSLATOR_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "CLOUDFLARE_API_TOKEN",
            "HOST_SSH_KEY",
            "RUNNER_PAIR_TOKEN",
        ]) {
            expect(CONTAINER_SECRET_ENV).toContain(name);
        }
    });

    test("leaves the ordinary settings a child needs", () => {
        for (const name of ["WORKSPACE_ROOT", "HISTORY_ROOT", "SANDBOX_PORT", "GOOGLE_CLIENT_ID", "SANDBOX_PUBLIC_URL"]) {
            expect(CONTAINER_SECRET_ENV).not.toContain(name);
        }
    });

    test("the runner's replay list and the daemon's schema agree on every name both declare", () => {
        const leaves = new Map(inspectSchema(configSchema).map((leaf) => [leaf.envName, leaf.secret]));
        const disagreements = REPLAY_ENV.filter((name) => leaves.has(name) && leaves.get(name) !== REPLAY_SECRET_ENV.has(name));
        expect(disagreements).toEqual([]);
        expect(CONFIG_SECRET_ENV.every((name) => leaves.get(name) === true)).toBe(true);
    });
});

describe("sealing the daemon's environment", () => {
    test("removes every secret name and keeps everything else", () => {
        const env: NodeJS.ProcessEnv = { CONNECT_TOKEN: "c", HOST_SSH_KEY: "k", OPENAI_API_KEY: "o", PATH: "/usr/bin", WORKSPACE_ROOT };
        sealConfigSecrets({ secretEnv: CONTAINER_SECRET_ENV, keys }, env);
        expect(env).toEqual({ PATH: "/usr/bin", WORKSPACE_ROOT });
    });

    test("hands each runtime its own fallback key and nothing else", () => {
        sealConfigSecrets({ secretEnv: CONTAINER_SECRET_ENV, keys }, {});
        expect(containerKeyEnv("claude")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-value" });
        expect(containerKeyEnv("codex")).toEqual({ OPENAI_API_KEY: "openai-value" });
    });

    test("still says which secrets the container was started with, never their values", () => {
        const env: NodeJS.ProcessEnv = { SANDBOX_GRANT: "ig1.payload.sig", CONNECT_TOKEN: "  ", PATH: "/usr/bin" };
        sealConfigSecrets({ secretEnv: CONTAINER_SECRET_ENV, keys }, env);
        const started = startedEnv(env);
        expect(started["PATH"]).toBe("/usr/bin");
        expect(started["SANDBOX_GRANT"]).not.toBe("ig1.payload.sig");
        expect((started["SANDBOX_GRANT"] ?? "").trim()).not.toBe("");
        // Blank was never given: it stays absent rather than reading as sealed.
        expect(started["CONNECT_TOKEN"]).toBeUndefined();
    });

    test("an unsealed daemon hands no runtime anything", () => {
        expect(containerKeyEnv("claude")).toEqual({});
        expect(containerKeyEnv("codex")).toEqual({});
    });
});
