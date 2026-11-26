import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILT_IN_WATCH_KINDS } from "@intentic/sandbox-contract/schemas/automations";

// One fake for the seam a contributed watch kind crosses: an installed extension declaring `npm` and `github-release` as
// the connectors extension does, its declarations derived from the contract's record of them rather than retyped.

export const WATCH_KINDS_EXTENSION = "acme.watches";

/** Writes the extension into `extensionsDir` (its install id is its directory, `acme.watches`). */
export const installWatchKinds = async (extensionsDir: string, capabilities: readonly object[] = []): Promise<void> => {
    const dir = join(extensionsDir, WATCH_KINDS_EXTENSION);
    await mkdir(dir, { recursive: true });
    const manifest = {
        publisher: "acme",
        name: "watches",
        version: "1.0.0",
        engines: { intentic: "^2.51.0" },
        server: "dist/server.js",
        contributes: {
            capabilities,
            watchKinds: BUILT_IN_WATCH_KINDS.map(({ extension: _extension, enabled: _enabled, ...kind }) => kind),
        },
    };
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(manifest));
};
