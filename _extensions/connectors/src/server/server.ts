import type { ExtensionServerApi, ServerActivation } from "@intentic/extension-api";
import { checkGithubRelease } from "./github-releases.js";
import { checkNpm } from "./npm-registry.js";

// The backend (2026-11-26): the checks of the two watch kinds this extension declares, `npm` and `github-release`,
// which the daemon held itself until then. It reaches no daemon route, so the manifest declares no `permissions.daemon`:
// a GitHub check gets the GitHub card's gateway address handed with the check, not by asking. Runs inside the daemon's
// extension host with node builtins and what it bundles.

export const activateServer = (api: ExtensionServerApi): ServerActivation => {
    const served = [
        api.checks.serve("npm", (check, { signal }) => checkNpm(check.params, fetch, signal)),
        api.checks.serve("github-release", (check, { signal }) => checkGithubRelease(check.params, fetch, { reach: check.reach, env: process.env }, signal)),
    ];
    // Nothing else to release: a check holds no listener, timer or process between calls.
    return { deactivate: () => served.forEach((each) => each.dispose()) };
};
