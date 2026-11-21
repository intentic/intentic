import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { runningWorkspace, workspaceDrifted } from "../workspaceDrift";

// When the extension host loads again by itself (useExtensionHost.ts): a list that names the workspace's own extensions
// otherwise than the last pass ran them, which is what a land moves. Installed ones keep their "Reload now".

const row = (name: string, over: Partial<ExtensionSummary> = {}): ExtensionSummary => ({
    id: `acme.${name}`,
    manifest: ExtensionManifestSchema.parse({ publisher: `acme`, name, version: `1.0.0`, engines: { intentic: `^0.2.0` } }),
    commit: `workspace`,
    source: `workspace`,
    enabled: true,
    revision: `aaaaaaaaaaaa`,
    ...over,
});

const LOADED = [row(`toolbox`), row(`pinned`, { source: `installed`, commit: `0123456789abcdef0123456789abcdef01234567`, revision: undefined })];

test(`a list naming the workspace's extensions as the host ran them is no news`, () => {
    expect(workspaceDrifted(runningWorkspace(LOADED), LOADED)).toBe(false);
    // An installed extension's update is the Extensions tab's to offer, never a reload by itself.
    expect(workspaceDrifted(runningWorkspace(LOADED), [LOADED[0] ?? row(`toolbox`), row(`pinned`, { source: `installed`, commit: `f`.repeat(40) })])).toBe(false);
});

test(`one a land turned on, one whose code moved, one switched off and one gone each load the host again`, () => {
    const loaded = runningWorkspace(LOADED);
    expect(workspaceDrifted(loaded, [...LOADED, row(`landed`)])).toBe(true);
    expect(workspaceDrifted(loaded, [row(`toolbox`, { revision: `bbbbbbbbbbbb` })])).toBe(true);
    expect(workspaceDrifted(loaded, [row(`toolbox`, { enabled: false })])).toBe(true);
    expect(workspaceDrifted(loaded, [])).toBe(true);
});
