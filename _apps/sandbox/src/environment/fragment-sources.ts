import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { contributionFor, contributionFragmentPath, contributionRegistry } from "../capabilities/contributions.js";
import { registry } from "../capabilities/registry.js";
import { extensionDir, extensionRead, extensionRootOf, readExtensionManifest } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";

/* The single resolver for every Dockerfile fragment a capability contributes to the composed overlay. Two
 * sources with DIFFERENT trust: core capability handlers (vpn/browser) return code-authored fragments
 * that MAY carry privileged `# intentic:runtime` directives; an extension's `contributes.environment.fragment`
 * is a checkout file restricted to RUN/ENV instructions only. Keeping the split here — not in
 * CapabilityHandler.fragment (which stays sync + trusted) — means the "what can an extension bake into the
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
        // The body of a continued RUN/ENV — not an instruction line, so don't re-check the leading keyword.
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

// Every fragment one capability entry contributes. The core handler fragment first (trusted), then — for an
// extension capability declaring contributes.environment — the checkout fragment, validated and skipped with a
// warn if it rotted or violates the allowlist (install-time already hard-rejected a bad fragment; this is the
// compose-time defense for a checkout that changed underneath).
export const capabilityFragments = async (services: Services, capability: Capability): Promise<string[]> => {
    const fragments: string[] = [];
    const core = registry[capability.kind].fragment?.(capability.config)?.trim();
    if (core !== undefined && core !== "") {
        fragments.push(core);
    }
    if (capability.kind === "extension") {
        const dir = extensionRootOf(extensionDir(services.workspace.root, capability.id), capability.config.path);
        const manifest = await readExtensionManifest(dir);
        const fragmentPath = manifest?.contributes?.environment?.fragment;
        if (fragmentPath !== undefined) {
            fragments.push(...(await readFragment(services, capability.id, join(dir, fragmentPath))));
        }
    }
    // A cli connector's image fragment (psql/mysql/whisper client) lives in the extension that declares the
    // connector — resolve it the same allowlisted way.
    if (capability.kind === "cli") {
        const connector = contributionFor(await contributionRegistry(services), "cli", capability.config);
        const fragmentPath = connector === undefined ? undefined : contributionFragmentPath(connector);
        if (fragmentPath !== undefined) {
            fragments.push(...(await readFragment(services, capability.id, fragmentPath)));
        }
    }
    return fragments;
};

// Read + allowlist-check an extension/connector fragment file; skip (with a warn) a missing or non-RUN/ENV one
// (install-time already hard-rejected a bad fragment; this is the compose-time defense for a rotted checkout).
const readFragment = async (services: Services, id: string, path: string): Promise<string[]> => {
    const content = (await extensionRead(path))?.trim();
    if (content === undefined || content === "") {
        services.logger.warn({ id }, "extension fragment missing at compose time — skipping");
        return [];
    }
    if (invalidExtensionFragment(content) !== undefined) {
        services.logger.warn({ id }, "extension fragment is not RUN/ENV-only — skipping");
        return [];
    }
    return [content];
};
