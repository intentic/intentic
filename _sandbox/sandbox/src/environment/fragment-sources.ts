import { join } from "node:path";
import { type Capability, invalidExtensionFragment } from "@intentic/sandbox-contract";
import { contributionFor, contributionFragmentPath, contributionPackName, contributionRegistry } from "../capabilities/contributions.js";
import { packFragment, readPack } from "./packs.js";
import { registry } from "../capabilities/registry.js";
import { extensionDir, extensionRead, extensionRootOf, readExtensionManifest } from "../capabilities/extension-dirs.js";
import { enabledExtensions } from "../extensions/installed-extensions.js";
import type { Services } from "../composition.js";

// Single resolver for every Dockerfile fragment a capability contributes. Core handlers return trusted code that may
// carry privileged `# intentic:runtime` directives; an extension's fragment is a checkout file restricted to RUN/ENV
// only via `invalidExtensionFragment`, the same grammar the platform's hosted rebuild re-checks.

// Every fragment one capability contributes: the trusted core handler fragment first, then an extension's checkout
// fragment, re-validated here as a compose-time defense against a checkout that changed since install.
export const capabilityFragments = async (services: Services, capability: Capability): Promise<string[]> => {
    const fragments: string[] = [];
    // One handler may contribute several blocks; a privileged half stays its own block, not folded in.
    const core = await registry[capability.kind].fragment?.(capability.config);
    for (const block of core === undefined ? [] : typeof core === "string" ? [core] : core) {
        const trimmed = block.trim();
        if (trimmed !== "") {
            fragments.push(trimmed);
        }
    }
    if (capability.kind === "extension") {
        const dir = extensionRootOf(extensionDir(services.workspace.root, capability.id), capability.config.path);
        const manifest = await readExtensionManifest(dir);
        const fragmentPath = manifest?.contributes?.environment?.fragment;
        if (fragmentPath !== undefined) {
            fragments.push(...(await readFragment(services, capability.id, join(dir, fragmentPath))));
        }
    }
    // A cli connector's tools come from a named pack, skipped if already baked, or an allowlisted fragment.
    if (capability.kind === "cli") {
        const connector = contributionFor(await contributionRegistry(services), "cli", capability.config);
        const pack = connector === undefined ? undefined : contributionPackName(connector);
        if (pack !== undefined) {
            fragments.push(...(await resolvePack(services, capability.id, pack)));
        }
        const fragmentPath = connector === undefined ? undefined : contributionFragmentPath(connector);
        if (fragmentPath !== undefined) {
            fragments.push(...(await readFragment(services, capability.id, fragmentPath)));
        }
    }
    return fragments;
};

// A named pack as a fragment, or nothing when the base already bakes that exact version. The two other empty cases are
// warned as manifest bugs: an unknown pack name, and a bake-only pack an overlay build has no context for.
const resolvePack = async (services: Services, id: string, name: string): Promise<string[]> => {
    const pack = await readPack(name);
    if (pack === undefined) {
        services.logger.warn({ id, pack: name }, "contribution names a feature pack that does not exist: skipping");
        return [];
    }
    if (!pack.overlayable) {
        services.logger.warn({ id, pack: name }, "contribution names a bake-only feature pack (it COPYs from the build context): skipping");
        return [];
    }
    const fragment = await packFragment(name);
    return fragment === undefined ? [] : [fragment];
};

// A workspace extension's fragment has no capability entry and no install moment, so the allowlist check here is its
// only gate; that's enough since it still only reaches the image through an owner-approved overlay. Baked extensions
// are deliberately excluded.
export const workspaceExtensionFragments = async (services: Services): Promise<string[]> => {
    const fragments: string[] = [];
    for (const extension of await enabledExtensions(services)) {
        const fragmentPath = extension.manifest.contributes?.environment?.fragment;
        if (extension.source === "workspace" && fragmentPath !== undefined) {
            fragments.push(...(await readFragment(services, extension.id, join(extension.dir, fragmentPath))));
        }
    }
    return fragments;
};

// Reads and allowlist-checks a fragment file; skips (with a warn) a missing or non-RUN/ENV one as defense against a
// checkout that rotted after install.
const readFragment = async (services: Services, id: string, path: string): Promise<string[]> => {
    const content = (await extensionRead(path))?.trim();
    if (content === undefined || content === "") {
        services.logger.warn({ id }, "extension fragment missing at compose time: skipping");
        return [];
    }
    if (invalidExtensionFragment(content) !== undefined) {
        services.logger.warn({ id }, "extension fragment is not RUN/ENV-only: skipping");
        return [];
    }
    return [content];
};
