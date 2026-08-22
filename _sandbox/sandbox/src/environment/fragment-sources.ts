import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { contributionFor, contributionFragmentPath, contributionPackName, contributionRegistry } from "../capabilities/contributions.js";
import { packFragment, readPack } from "./packs.js";
import { registry } from "../capabilities/registry.js";
import { extensionDir, extensionRead, extensionRootOf, readExtensionManifest } from "../capabilities/extension-dirs.js";
import { enabledExtensions } from "../extensions/installed-extensions.js";
import type { Services } from "../composition.js";

/* The single resolver for every Dockerfile fragment a capability contributes to the composed overlay. Two
 * sources with DIFFERENT trust: core capability handlers (vpn/browser) return code-authored fragments
 * that MAY carry privileged `# intentic:runtime` directives; an extension's `contributes.environment.fragment`
 * is a checkout file restricted to RUN/ENV instructions only. Keeping the split here, not in
 * CapabilityHandler.fragment (which stays sync + trusted), means the "what can an extension bake into the
 * image" security surface is exactly `invalidExtensionFragment`. composeEnvironment calls this per capability. */

// Reject anything an extension fragment must not contain: FROM (the daemon owns the base pin), any privileged
// runtime directive, and any Dockerfile instruction other than RUN/ENV. Continuation-aware (a `\`-continued
// RUN body spans lines). Returns the offending line, or undefined when the fragment is clean.
export const invalidExtensionFragment = (content: string): string | undefined => {
    let continued = false;
    for (const raw of content.split("\n")) {
        const line = raw.trim();
        const wasContinued = continued;
        continued = line.endsWith("\\");
        if (line === "" || line.startsWith("#")) {
            // A comment could still smuggle a runtime directive that an out-of-band rebuild executor greps for.
            if (line.includes("intentic:runtime")) {
                return raw;
            }
            continue;
        }
        // The body of a continued RUN/ENV, not an instruction line, so don't re-check the leading keyword.
        if (wasContinued) {
            if (line.includes("intentic:runtime")) {
                return raw;
            }
            continue;
        }
        if (!/^(run|env)\s/i.test(line) || line.includes("intentic:runtime")) {
            return raw;
        }
    }
    return undefined;
};

// Every fragment one capability entry contributes. The core handler fragment first (trusted), then, for an
// extension capability declaring contributes.environment, the checkout fragment, validated and skipped with a
// warn if it rotted or violates the allowlist (install-time already hard-rejected a bad fragment; this is the
// compose-time defense for a checkout that changed underneath).
export const capabilityFragments = async (services: Services, capability: Capability): Promise<string[]> => {
    const fragments: string[] = [];
    // One handler may contribute several blocks: see CapabilityHandler.fragment for why the privileged half is
    // kept as its own byte-identical block rather than folded into the tools it accompanies.
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
    // A cli connector's tools (psql/mysql/whisper client) come either from a feature pack it NAMES — the
    // stamp-aware route, nothing composed when the base already bakes it — or from a fragment file in the
    // extension that declares the connector, read the same allowlisted way.
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

/* A named feature pack as an overlay fragment, or NOTHING when the running base image already bakes that exact
 * pack version — which is the whole reason a contribution should name a pack rather than copy one. The two
 * empty-handed cases that are NOT that are warned about, because they are manifest bugs that would otherwise
 * present as a capability silently missing its tool: a name no pack answers to, and a bake-only pack (one that
 * COPYs from the image build context, which an overlay build has no context for). */
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

// A WORKSPACE extension's contributes.environment fragment. It has no capability entry, so the per-capability
// resolver above never reaches it, and no install moment either, so unlike a checkout the allowlist check
// below is its ONLY gate. That is enough: the fragment still only reaches the image through the overlay the
// owner approves and rebuilds out-of-band. Baked extensions stay out deliberately (their fragments are inert
// by design, rtk is git-install opt-in for exactly that reason).
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

// Read + allowlist-check an extension/connector fragment file; skip (with a warn) a missing or non-RUN/ENV one
// (install-time already hard-rejected a bad fragment; this is the compose-time defense for a rotted checkout).
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
