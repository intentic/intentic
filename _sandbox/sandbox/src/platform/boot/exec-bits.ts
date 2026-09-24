import { chmod, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";

// Where the image installs the daemon; the dev sandbox bind-mounts a host build over its dist.
export const SANDBOX_INSTALL_DIR = "/opt/sandbox/";

// A build that emits into a bind mount (the dev sandbox's host-built dist) drops the image's chmod +x, so a PATH symlink
// into the install resolves to a file the shell refuses to run. Found by discovery: every such symlink, none listed.
export const restoreExecBits = async (binDir: string, installDir: string, logger: Logger): Promise<readonly string[]> => {
    const repaired: string[] = [];
    for (const name of await readdir(binDir)) {
        const target = await realpath(join(binDir, name)).catch(() => undefined);
        if (target === undefined || !target.startsWith(installDir)) {
            continue;
        }
        const { mode } = await stat(target);
        if ((mode & 0o111) === 0o111) {
            continue;
        }
        await chmod(target, mode | 0o111);
        repaired.push(name);
    }
    if (repaired.length > 0) {
        logger.info({ repaired, installDir }, "boot: restored the exec bit on PATH commands that point into the daemon's install");
    }
    return repaired;
};
