import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homeDir } from "@intentic/local-agent";
import { icCandidates } from "../device/tools/ic-binary.js";
import { fleet } from "../device/tools/sandboxes.js";
import { trashedSlugs } from "./gone.js";

// WHAT THIS MACHINE'S ic HOLDS, for the local witness of a gone sandbox (gone.ts `localVerdict`): the slugs its listing
// names, and the slugs its trash holds. Each is undefined when ic did not answer it, which is never read as "none":
// Docker Desktop not started yet answers no listing at all, and a sandbox read as gone on that would be retired.
// Asked of whatever ic is installed, never fetching a newer one first: a background round has no business downloading.

const exec = promisify(execFile);

// A listing on a busy machine; the same patience the device tools give ic's JSON listing.
const LIST_TIMEOUT_MS = 60_000;

export interface LocalSandboxes {
    readonly listed: readonly string[] | undefined;
    readonly trashed: readonly string[] | undefined;
}

// `ic sandbox list`, the text form: the one place ic names its trash ("removed, still recoverable").
const icListingText = async (): Promise<string | undefined> => {
    for (const binary of icCandidates(process.platform, homeDir())) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates in order; the first that runs answers
        const answer = await exec(binary, ["sandbox", "list"], { timeout: LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).then(
            (ran) => ({ ran: true as const, stdout: ran.stdout }),
            (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : { ran: false as const, stdout: "" }),
        );
        if (answer !== undefined) {
            return answer.ran ? answer.stdout : undefined;
        }
    }
    return undefined;
};

export const readLocalSandboxes = async (): Promise<LocalSandboxes> => {
    // allow(silent-catch): an ic that cannot list (none installed, Docker down) is no answer, which the caller reads as unknown
    const listed = await fleet({ current: false }).then(
        (rows) => rows.map((row) => row.slug),
        () => undefined,
    );
    if (listed === undefined) {
        return { listed: undefined, trashed: undefined };
    }
    const text = await icListingText();
    return { listed, trashed: text === undefined ? undefined : trashedSlugs(text) };
};
