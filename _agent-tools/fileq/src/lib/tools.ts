import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/* Is a binary on PATH? */
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
