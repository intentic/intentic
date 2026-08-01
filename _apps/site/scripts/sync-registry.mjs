import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { OFFICIAL_REGISTRY_URL, REGISTRY_FACTS_FILE, REGISTRY_FILE } from "@intentic/registry";

/* Refresh the vendored copy the gallery build falls back to when GitHub can't be reached
 * (src/lib/registry.ts). Run it when the registry has moved on enough that an offline build would look
 * embarrassing; nothing depends on it being current, which is the entire point of having it. */

const RAW_BASE = `${OFFICIAL_REGISTRY_URL.replace("https://github.com/", "https://raw.githubusercontent.com/")}/HEAD`;

const read = async (path) => {
    const response = await fetch(`${RAW_BASE}/${path}`);
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`registry ${response.status} fetching ${path}`);
    }
    return response.json();
};

const file = await read(REGISTRY_FILE);
if (file === undefined) {
    throw new Error(`no ${REGISTRY_FILE} in ${OFFICIAL_REGISTRY_URL}`);
}
const facts = await read(REGISTRY_FACTS_FILE);

const target = fileURLToPath(new URL("../src/lib/registry.fallback.json", import.meta.url));
await writeFile(target, `${JSON.stringify({ file, facts: facts ?? { scannedAt: undefined, entries: [] } }, null, 4)}\n`, "utf8");
console.log(`vendored ${file.plugins.length} entries into src/lib/registry.fallback.json`);
