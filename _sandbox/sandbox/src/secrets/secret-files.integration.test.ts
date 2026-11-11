import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCommandSecrets, type SecretAccess, type SecretUseReport } from "./secret-access.js";
import { FILE_TTL_MS, writeSecretFile } from "./secret-files.js";
import type { NamedSecret } from "./secret-registry.js";

// `{{secret:NAME|file}}` on a real temp tree: the command gets a path, the file holds the value byte for byte and only
// its owner reads it, and a file an earlier daemon left past its time is swept by the next write.

const DOTENV: NamedSecret = { name: "DEV_ENV", value: "# dev\nAPI_KEY='a b $(rm -rf ~)'\nQUOTE=\"x\"\n", source: "sandbox" };

const withRoot = async (use: (root: string) => Promise<void> | void): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), "secret-files-test-"));
    try {
        await use(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

test("a |file reference becomes the path of a private file holding the value exactly, after the gates", () =>
    withRoot(async (root) => {
        const steps: string[] = [];
        const uses: SecretUseReport[] = [];
        const secrets: SecretAccess = {
            list: async () => [DOTENV],
            used: (use) => void uses.push(use),
            release: async (names) => {
                steps.push(`release ${names.join(",")}`);
                return { ok: true };
            },
        };
        const resolved = await resolveCommandSecrets("set -a; . {{secret:DEV_ENV|file}}; set +a", secrets, "shell", "Bash", root);
        expect("command" in resolved).toBe(true);
        const path = "command" in resolved ? resolved.command.replace("set -a; . ", "").replace("; set +a", "") : "";
        expect(path.startsWith(`${root}/intentic-secret-`)).toBe(true);
        expect(path).toMatch(/^[A-Za-z0-9_./-]+$/u);
        expect(readFileSync(path, "utf8")).toBe(DOTENV.value);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
        expect(steps).toEqual(["release DEV_ENV"]);
        expect(uses.map((use) => `${use.name}:${use.detail ?? ""}`)).toEqual(["DEV_ENV:set -a; . {{secret:DEV_ENV|file}}; set +a"]);
    }));

test("a sweep removes a file left past its time by an earlier daemon", () =>
    withRoot((root) => {
        const old = writeSecretFile(root, "old");
        const fresh = writeSecretFile(root, "fresh", Date.now() + FILE_TTL_MS + 60_000);
        expect(existsSync(dirname(old))).toBe(false);
        expect(readFileSync(fresh, "utf8")).toBe("fresh");
    }));
