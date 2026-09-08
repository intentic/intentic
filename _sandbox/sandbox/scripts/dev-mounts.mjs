#!/usr/bin/env node
// Dev bind-mounts so a running sandbox container reads compiled JS from the working tree, not the baked image layer.
// Only existing host paths are printed; a missing dist falls back to the baked copy. Mounts compiled output only, never
// node_modules: native builds (e.g. node-pty) are built against the image's own ABI.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { bakedPackageNames, packageDir, REPO_ROOT, SANDBOX_ROOT, workspacePackages } from "./dev-baked-packages.mjs";

const mounts = [];
const push = (hostPath, containerPath) => {
    if (existsSync(hostPath)) {
        mounts.push(`${hostPath}:${containerPath}`);
    }
};

push(join(REPO_ROOT, "_sandbox/sandbox/dist"), `${SANDBOX_ROOT}/dist`);

// Each baked package's compiled output, mounted over the pruned copy in the daemon's node_modules.
const packages = workspacePackages();
for (const name of bakedPackageNames()) {
    const dir = packages.get(name);
    if (dir !== undefined) {
        push(join(dir, "dist"), `${packageDir(name)}/dist`);
    }
}

process.stdout.write(mounts.join("\n") + (mounts.length > 0 ? "\n" : ""));
