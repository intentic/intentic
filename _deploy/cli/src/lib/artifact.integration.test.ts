import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_FILE, loadEnvFile } from "./artifact.js";

describe("loadEnvFile", () => {
    it("loads secrets from the .env beside the artifact into process.env", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-env-"));
        await writeFile(join(dir, ENV_FILE), "INTENTIC_TEST_SECRET=from-dotenv\n");

        loadEnvFile(dir);

        expect(process.env["INTENTIC_TEST_SECRET"]).toBe("from-dotenv");
        delete process.env["INTENTIC_TEST_SECRET"];
    });

    it("fills a var that is set but empty (an empty launcher-injected var must not shadow .env)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-env-"));
        await writeFile(join(dir, ENV_FILE), "INTENTIC_TEST_SECRET=from-dotenv\n");
        process.env["INTENTIC_TEST_SECRET"] = "";

        loadEnvFile(dir);

        expect(process.env["INTENTIC_TEST_SECRET"]).toBe("from-dotenv");
        delete process.env["INTENTIC_TEST_SECRET"];
    });

    it("keeps a non-empty var from the real environment over the .env value", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-env-"));
        await writeFile(join(dir, ENV_FILE), "INTENTIC_TEST_SECRET=from-dotenv\n");
        process.env["INTENTIC_TEST_SECRET"] = "from-shell";

        loadEnvFile(dir);

        expect(process.env["INTENTIC_TEST_SECRET"]).toBe("from-shell");
        delete process.env["INTENTIC_TEST_SECRET"];
    });

    it("is a no-op when no .env is present", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-env-"));
        expect(() => loadEnvFile(dir)).not.toThrow();
    });
});
