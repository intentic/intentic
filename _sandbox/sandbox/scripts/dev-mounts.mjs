#!/usr/bin/env node
// The dev bind-mounts that make a running sandbox read its compiled JavaScript from the working tree instead of
// from the image layer it was baked into.
//
// Prints one `hostPath:containerPath` per line for dev-sandbox.sh to turn into `-v` flags. Only paths that
// actually exist on the host are printed: a missing dist must fall back to the baked copy rather than mount an
// empty directory over a working daemon.
//
// Why this exists: the daemon is COPY'd into the image (Dockerfile: `COPY --from=trees sandbox /opt/sandbox`),
// so without these mounts the only way a running container can reflect a source edit is a full
// `pnpm build:sandbox`: turbo, six `pnpm deploy` prunes, and a docker build, minutes per edit. That latency is
// what made "did my change even land?" the most expensive question in the project. With them, a daemon edit is
// `tsgo` plus `docker restart`: seconds. See dev-reload.sh.
//
// Only compiled output is mounted, never node_modules: each baked package keeps the image's own installed
// dependencies (including its native builds: node-pty is rebuilt inside the image against its ABI, and a host
// copy would be wrong).
// A manifest is installed by an image build and by nothing else, so a package that gained an export subpath
// since the image was baked mounts a dist its own package.json refuses to resolve: dev-manifest-drift.mjs is
// the guard for that, and shares this file's idea of which packages are baked.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { bakedPackageNames, packageDir, REPO_ROOT, SANDBOX_ROOT, workspacePackages } from "./dev-baked-packages.mjs";

const mounts = [];
const push = (hostPath, containerPath) => {
    if (existsSync(hostPath)) {
        mounts.push(`${hostPath}:${containerPath}`);
    }
};

// The daemon's own compiled output.
push(join(REPO_ROOT, "_sandbox/sandbox/dist"), `${SANDBOX_ROOT}/dist`);

// Each baked workspace package's compiled output, mounted over the pruned copy in the daemon's node_modules.
const packages = workspacePackages();
for (const name of bakedPackageNames()) {
    const dir = packages.get(name);
    if (dir !== undefined) {
        push(join(dir, "dist"), `${packageDir(name)}/dist`);
    }
}

process.stdout.write(mounts.join("\n") + (mounts.length > 0 ? "\n" : ""));
