import { describe, expect, test } from "vitest";
import { holdsCredentialMaterial, maskCredentialMaterial } from "./credential-material.js";

// The two directions aren't symmetric: a miss just raises an extra card, a wrong clear un-gates a real credential read.
// The "no" cases have to be exactly right; every "yes" case is a real file's real shape.

describe("files that hold a credential", () => {
    test("an npmrc with a token", () => {
        expect(holdsCredentialMaterial("//registry.npmjs.org/:_authToken=npm_wCq3nTvR8xLm2ZbKp7HdJyE4sUaF6gN0iQ1t\n")).toBe(true);
    });

    test("an aws credentials ini", () => {
        expect(
            holdsCredentialMaterial("[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG\n"),
        ).toBe(true);
    });

    test("a private key file, whatever generated it", () => {
        for (const text of [
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n",
            "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n",
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n",
        ]) {
            expect(holdsCredentialMaterial(text), text.slice(0, 30)).toBe(true);
        }
    });

    test("a password carried in a URL", () => {
        expect(holdsCredentialMaterial("https://radarsu:ghp_S8kQ2mVx@github.com\n")).toBe(true);
        expect(holdsCredentialMaterial("DATABASE_URL=postgres://app:Rk29fPqz@db.internal:5432/app\n")).toBe(true);
    });

    test("a dotenv with one real value among the ordinary ones", () => {
        expect(holdsCredentialMaterial("PORT=3000\nNODE_ENV=production\nSTRIPE_SECRET=sk_live_51H8xQzRvKpLmNbTy\n")).toBe(true);
    });

    test("a json credentials file", () => {
        expect(holdsCredentialMaterial('{"accessToken":"ya29.a0AfB_bJq2Lm","expiresAt":1767000000}')).toBe(true);
    });

    test("a token that carries its own prefix", () => {
        for (const text of [
            "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
            "xoxb-2410-1230-AbCdEfGhIjKlMnOpQrSt",
            "AKIAIOSFODNN7EXAMPLE",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ]) {
            expect(holdsCredentialMaterial(text), text.slice(0, 20)).toBe(true);
        }
    });
});

describe("files that do not", () => {
    test("an npmrc with only registry config", () => {
        expect(holdsCredentialMaterial("registry=https://registry.npmjs.org/\nengine-strict=true\nstore-dir=/root/.pnpm-store\n")).toBe(
            false,
        );
    });

    test("a dotenv of ports and flags", () => {
        expect(holdsCredentialMaterial("PORT=3000\nNODE_ENV=development\nVITE_API_URL=http://localhost:8080\nLOG_LEVEL=debug\n")).toBe(false);
    });

    test("a dotenv whose credential keys are still placeholders", () => {
        expect(
            holdsCredentialMaterial(
                [
                    "GITHUB_TOKEN=",
                    "NPM_TOKEN=${NPM_TOKEN}",
                    "API_KEY=<your-api-key>",
                    'CLIENT_SECRET=""',
                    "DB_PASSWORD=changeme",
                    "SLACK_TOKEN=xxxxxxxx",
                    "STRIPE_SECRET={{secret:STRIPE}}",
                    "AUTH_TOKEN=your-token-here",
                    "SESSION_SECRET=REDACTED",
                ].join("\n"),
            ),
        ).toBe(false);
    });

    test("the public files an ssh directory is full of", () => {
        expect(holdsCredentialMaterial("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH1x radarsu@omen\n")).toBe(false);
        expect(holdsCredentialMaterial("github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzr\n")).toBe(false);
        expect(holdsCredentialMaterial("Host github.com\n  User git\n  IdentityFile ~/.ssh/id_ed25519\n")).toBe(false);
    });

    test("a key whose name only looks like one", () => {
        expect(holdsCredentialMaterial("TOKEN_EXPIRY=3600\nREFRESH_TOKEN_URL=https://auth.example.com/refresh\nMAX_TOKENS=8192\n")).toBe(
            false,
        );
    });

    test("a dev-compose default is not what the card is for", () => {
        expect(holdsCredentialMaterial("POSTGRES_PASSWORD=dev\nREDIS_PASSWORD=x\n")).toBe(false);
    });

    test("an empty file", () => {
        expect(holdsCredentialMaterial("")).toBe(false);
        expect(holdsCredentialMaterial("\n\n# nothing here\n")).toBe(false);
    });

    test("an ordinary url is not userinfo", () => {
        expect(holdsCredentialMaterial("API=http://localhost:8080/v1\nSENTRY_DSN=https://abc123@o1.ingest.sentry.io/1\n")).toBe(false);
    });
});

// The same table applied to masking, not detection: what matters is what SURVIVES (structure, keys, comments), since
// this runs over files an agent legitimately edits.
describe("masking what a credential file holds", () => {
    test("a dotenv keeps its keys, its shape and its comments", () => {
        const masked = maskCredentialMaterial(
            ["# staging", "PORT=3000", "NODE_ENV=production", 'STRIPE_SECRET="sk_live_51H8xQzRvKpLmNbTy"', "MAX_TOKENS=8192"].join("\n"),
        );
        expect(masked).toBe(["# staging", "PORT=3000", "NODE_ENV=production", 'STRIPE_SECRET="***"', "MAX_TOKENS=8192"].join("\n"));
    });

    test("a placeholder and a secret reference come back untouched", () => {
        const template = ["GITHUB_TOKEN=", "NPM_TOKEN=${NPM_TOKEN}", "API_KEY=<your-api-key>", "STRIPE_SECRET={{secret:STRIPE}}"].join("\n");
        expect(maskCredentialMaterial(template)).toBe(template);
    });

    test("a private key keeps the lines that say what it is", () => {
        const masked = maskCredentialMaterial("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n");
        expect(masked).toBe("-----BEGIN OPENSSH PRIVATE KEY-----\n***\n-----END OPENSSH PRIVATE KEY-----\n");
    });

    test("a url keeps everything but the password", () => {
        expect(maskCredentialMaterial("DATABASE_URL=postgres://app:Rk29fPqz@db.internal:5432/app\n")).toBe(
            "DATABASE_URL=postgres://app:***@db.internal:5432/app\n",
        );
    });

    test("an issued token goes wherever it appears", () => {
        expect(maskCredentialMaterial("gh auth: ghp_16C7e42F292c6912E7710c838347Ae178B4a expired")).toBe("gh auth: *** expired");
        expect(maskCredentialMaterial("//registry.npmjs.org/:_authToken=npm_wCq3nTvR8xLm2ZbKp7HdJyE4sUaF6gN0iQ1t")).toBe(
            "//registry.npmjs.org/:_authToken=***",
        );
    });

    test("the ordinary contents of a config file survive", () => {
        for (const text of [
            "registry=https://registry.npmjs.org/\nengine-strict=true\n",
            "TOKEN_EXPIRY=3600\nMAX_TOKENS=8192\nREFRESH_TOKEN_URL=https://auth.example.com/refresh\n",
            "Host github.com\n  User git\n  IdentityFile ~/.ssh/id_ed25519\n",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH1x radarsu@omen\n",
            "POSTGRES_PASSWORD=dev\n",
        ]) {
            expect(maskCredentialMaterial(text), text.slice(0, 30)).toBe(text);
        }
    });

    test("what comes back no longer holds credential material", () => {
        for (const text of [
            "//registry.npmjs.org/:_authToken=npm_wCq3nTvR8xLm2ZbKp7HdJyE4sUaF6gN0iQ1t\n",
            "[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG\n",
            '{"accessToken":"ya29.a0AfB_bJq2Lm","expiresAt":1767000000}',
            "PORT=3000\nSTRIPE_SECRET=sk_live_51H8xQzRvKpLmNbTy\n",
            "https://radarsu:ghp_S8kQ2mVx@github.com\n",
        ]) {
            expect(holdsCredentialMaterial(text), `${text.slice(0, 30)} before`).toBe(true);
            expect(holdsCredentialMaterial(maskCredentialMaterial(text)), `${text.slice(0, 30)} after`).toBe(false);
        }
    });
});
