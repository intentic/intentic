import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { describe, expect, it } from "vitest";
import { parseDefinitionToml } from "./definition.js";

// The platform ships one sandbox.toml per profile and hands it to a new machine as base64 in SANDBOX_DEFINITION_SEED;
// main.ts decodes and applies it on first boot. That step swallows its own failure on purpose — a sandbox that cannot
// read its seed still has to come up — so a typo in one of these files costs the reader everything the profile
// promised and says nothing anywhere they will look. This is where it is caught instead: the real parser, on the real
// files, through the same base64 the daemon is handed.

const PROFILES_DIR = join(repoRoot(import.meta.url), `_platform/api/src/sandbox/profiles`);
const files = readdirSync(PROFILES_DIR).filter((name) => name.endsWith(`.sandbox.toml`));

describe(`the profile definitions the platform seeds`, () => {
    it(`ships at least one, or the seed path is dead code`, () => {
        expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)(`%s is a definition this daemon can read`, (name) => {
        const toml = readFileSync(join(PROFILES_DIR, name), `utf8`);
        // Exactly what the daemon does with the env value it is given.
        const seeded = Buffer.from(Buffer.from(toml, `utf8`).toString(`base64`), `base64`).toString(`utf8`);
        const definition = parseDefinitionToml(seeded);
        expect(definition.schemaVersion).toBe(1);
        // A definition that parses but declares nothing applies nothing, which is the same outcome as the typo.
        const declared = [Object.keys(definition.settings).length, definition.capabilities.length, definition.repositories.length];
        expect(declared.some((count) => count > 0)).toBe(true);
    });
});
