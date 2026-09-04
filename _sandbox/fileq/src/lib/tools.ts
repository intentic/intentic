import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/* Is a binary on PATH? Synchronous and uncached on purpose: a deriver's IDENTITY (its sidecar stamp) can
 * depend on which tools the image carries, and that identity is read at routing time before any file is
 * opened, so the check has to be callable from a plain property getter. A handful of stat calls per file is
 * nothing next to parsing the file, and no cache means a test can flip PATH and watch the answer change. */
export const onPath = (command: string): boolean =>
    (process.env["PATH"] ?? "").split(":").some((dir) => {
        if (dir === "") {
            return false;
        }
        try {
            accessSync(join(dir, command), constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
