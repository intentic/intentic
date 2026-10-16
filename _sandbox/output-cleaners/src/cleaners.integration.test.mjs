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

test("a value a computer's keyring released, and a keyring entry kept here as a copy, are masked by the terminal filter", () => {
    withStores(({ auth, env }) => {
        writeFileSync(join(auth, "keyring-released.json"), JSON.stringify({ VPN_PASSWORD: "released-0004dd" }));
        writeFileSync(join(auth, "keyring-copies.json"), JSON.stringify({ DB_PASSWORD: "copied-0005ee" }));
        expect(redactText("vpn released-0004dd db copied-0005ee", secretValues(env))).toBe(
            `vpn ${secretReference("VPN_PASSWORD")} db ${secretReference("DB_PASSWORD")}`,
        );
    });
});

// Sealed the way the daemon seals a store at rest (src/store/encryption/at-rest.ts), so the filter's reader is checked
// against the same envelope, not against itself.
const sealAtRest = async (text, purpose, key) => {
    const { createCipheriv, createHash, hkdfSync, randomBytes } = await import("node:crypto");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", key, "intentic-at-rest-v1", purpose, 32)), iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return `INTENTIC-ENC-v1:${JSON.stringify({ keyId, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") })}\n`;
};

test("a store encrypted at rest is masked when the filter can read the key, and quietly skipped when it cannot", async () => {
    const { randomBytes } = await import("node:crypto");
    const key = randomBytes(32);
    const sealed = await sealAtRest(JSON.stringify({ GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz" }), "sandbox-secrets.json", key);
    withStores(({ auth, env }) => {
        const keyFile = join(auth, "..", "at-rest.key");
        writeFileSync(keyFile, key);
        writeFileSync(join(auth, "sandbox-secrets.json"), sealed);
        expect(secretValues({ ...env, INTENTIC_AT_REST_KEY_FILE: keyFile })).toEqual([{ target: "ghp_abcdefghijklmnopqrstuvwxyz", replacement: secretReference("GITHUB_TOKEN") }]);
    });
    // A fresh store, since what was read is cached by the file's own stamp.
    withStores(({ auth, env }) => {
        writeFileSync(join(auth, "sandbox-secrets.json"), sealed);
        expect(secretValues({ ...env, INTENTIC_AT_REST_KEY_FILE: join(auth, "missing.key") })).toEqual([]);
    });
});
