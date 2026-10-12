import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { redactText, secretReference, secretValues } from "./cleaners.mjs";

// Every store sits under a fresh workspace root and auth root, so each test reads exactly the files it wrote.
const withStores = (run) => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-secrets-"));
    try {
        const repo = join(root, "desired-state");
        const auth = join(root, "auth");
        mkdirSync(repo, { recursive: true });
        mkdirSync(auth, { recursive: true });
        run({ repo, auth, env: { WORKSPACE_ROOT: root, AGENT_AUTH_DIR: auth } });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

test("secretValues reads the descriptor-backed store and preserves its reference name", () => {
    withStores(({ repo, env }) => {
        writeFileSync(join(repo, ".env"), "CUSTOM_CREDENTIAL=a1b2c3d4e5f6g7h8i9j0k1\n");
        expect(secretValues(env)).toEqual([{ target: "a1b2c3d4e5f6g7h8i9j0k1", replacement: secretReference("CUSTOM_CREDENTIAL") }]);
    });
});

test("a secret pasted on a need card (sandbox-secrets.json) is masked by the terminal filter", () => {
    withStores(({ auth, env }) => {
        writeFileSync(join(auth, "sandbox-secrets.json"), JSON.stringify({ OPENAI_API_KEY: "kept-on-a-card-7Hq2Zx9" }));
        expect(redactText("echo kept-on-a-card-7Hq2Zx9 | wc -c", secretValues(env))).toBe(`echo ${secretReference("OPENAI_API_KEY")} | wc -c`);
    });
});

test("a .env value followed by a comment masks the value, and the comment is not a secret", () => {
    withStores(({ repo, env }) => {
        writeFileSync(join(repo, ".env"), "API_SECRET=v4lu3-0nly-Kq8Zp2 # rotated every month by ops\n");
        const values = secretValues(env);
        expect(values).toEqual([{ target: "v4lu3-0nly-Kq8Zp2", replacement: secretReference("API_SECRET") }]);
        expect(redactText("rotated every month by ops", values)).toBe("rotated every month by ops");
    });
});

test("a backtick-quoted .env value registers without its backticks", () => {
    withStores(({ repo, env }) => {
        // envLine (_shared/sandbox-run/src/quote.ts) picks a backtick when the value holds both other quotes.
        writeFileSync(join(repo, ".env"), "QUOTED_TOKEN=`it's \"both\" 9Xk2mQ7pL`\n");
        const targets = secretValues(env).map(({ target }) => target);
        expect(targets).toContain(`it's "both" 9Xk2mQ7pL`);
        expect(targets.filter((target) => target.includes("`"))).toEqual([]);
    });
});

test("every store contributes, named the way the daemon's registry names it", () => {
    withStores(({ repo, auth, env }) => {
        writeFileSync(join(repo, ".env"), "FROM_ENV_FILE=env-value-0001aa\n");
        writeFileSync(join(repo, ".secrets.json"), JSON.stringify({ GENERATED_ONE: "generated-0002bb" }));
        writeFileSync(join(auth, "sandbox-secrets.json"), JSON.stringify({ KEPT_ONE: "kept-value-0003cc" }));
        writeFileSync(join(auth, "capability-secrets.json"), JSON.stringify({ reddit: { password: "vaulted-0004dd" } }));
        expect(
            secretValues(env)
                .map(({ replacement }) => replacement)
                .toSorted(),
        ).toEqual(["FROM_ENV_FILE", "GENERATED_ONE", "KEPT_ONE", "reddit/password"].map(secretReference));
    });
});
