import { join } from "node:path";
import { findWorkspaceRoot } from "@intentic/connector-runtime";
// The subpath, not the package root: the root loads every schema in the contract, which `gw` never needs.
import { extensionStateDir } from "@intentic/sandbox-contract/workspace-state";

/* WHERE THIS EXTENSION KEEPS ITS SCRATCH STATE, one hour of cached access token per connection, and the watcher's resume marks. */

// The extension's identity (publisher.name), which names its state directory: the gateway's `api.stateDir`, and the
// same directory `gw` finds from wherever the agent stands, having no api of its own.
const IDENTITY = "intentic.google-workspace";

// INTENTIC_WORKSPACE, else the nearest ancestor holding `.intentic`, else WORKSPACE_ROOT: the one walk every
// agent-side CLI of a connector does (connector-runtime's findWorkspaceRoot).
export const workspaceRoot = (env: NodeJS.ProcessEnv, cwd: string): string => findWorkspaceRoot(env, cwd);

// A connection's own directory under the runtime tree. `name` is an env suffix lowercased, so it is already
// slug-shaped; the replace is defence in depth against a path ever being built from something else.
export const runtimeDir = (root: string, name: string): string =>
    join(root, extensionStateDir(IDENTITY), name.replaceAll(/[^a-zA-Z0-9._-]/g, "_"));
