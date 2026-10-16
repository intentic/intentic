import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";
import { isMissing } from "@intentic/base/errors";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

// The platform's own id for this sandbox's row, as its announce last answered it (ingress-schemas.ts
// AnnounceAcceptedSchema). The container knows its 12-hex tunnel id from its connect token, but the editor keys
// everything by the platform's id, so the machine that runs the sandbox needs this one to open it by the same name with
// no network: `ic sandbox session` and `ic sandbox list --json` read it (through auth/host/host-session-cli.js and `docker cp`).
// A plain file rather than a converted document: one string, written whole, and read by a host that is not this build.
// It sits in store/, the foundation layer, because system/ (the announce writes it) and auth/ (the host-session script
// reads it) share a layer, and either importing the other's copy would close a cycle between them.

// Spelled where it is joined, as every /history path is, so the state table's coverage test sees it built.
const rowFile = (historyRoot: string): string => join(historyRoot, "platform-row.json");

const PlatformRowSchema = z.object({ platformId: z.string().min(1) });

// Undefined before any announce named one, and for a file that is not one: a guess at an id would open the wrong row.
export const readPlatformRow = async (historyRoot: string): Promise<string | undefined> => {
    try {
        return parseJsonWith(await readFile(rowFile(historyRoot), "utf8"), PlatformRowSchema)?.platformId;
    } catch (error) {
        if (isMissing(error)) {
            return undefined;
        }
        throw error;
    }
};

// Written only when it changed: every hourly heartbeat names it again. A file that cannot be read throws, and the
// announcer's listener says so (composition.ts) rather than write over what it could not see.
export const rememberPlatformRow = async (historyRoot: string, platformId: string): Promise<void> => {
    if ((await readPlatformRow(historyRoot)) === platformId) {
        return;
    }
    await writeFileAtomic(rowFile(historyRoot), `${JSON.stringify({ platformId })}\n`, 0o644);
};
