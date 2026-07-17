import { join } from "node:path";
import { ExtensionManifestSchema } from "@intentic/extension-api";
import type { ExtensionConfig } from "@intentic/sandbox-contract";
import { invalidExtensionFragment } from "../../environment/fragment-sources.js";
import { extensionProcessKey } from "../../extensions/extension-processes.js";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import type { CapabilityHandler } from "../capability.js";
import { extensionDir, extensionRootOf, extensionsRoot, readExtensionManifest } from "../extension-dirs.js";
import { checkoutInto } from "../git-checkout.js";

// An intentic extension: a git checkout at .intentic/extensions/<id>, sha-pinned by construction (the config
// schema requires a full commit sha, so the owner approves EXACTLY the code that runs; an update is an explicit
// re-add at a new sha). Install validates the manifest and the prebuilt entry bundle BEFORE the staged checkout
// goes live, so a broken extension never replaces a working one. The extensions routes serve the manifest list
// + bundle; agent contributions ride extensionAgentDirsOf into the SDK's plugin loader.
export const extensionHandler: CapabilityHandler = {
    apply: async function* (ctx, id, config) {
        const { url, ref, path, token } = config as ExtensionConfig;
        const session = capabilityJobSession(id);
        if (ctx.terminalRun.visible) {
            yield { kind: "terminal", session };
        }
        yield { kind: "log", message: `Cloning ${url} @ ${ref}…` };
        await checkoutInto(ctx, session, extensionsRoot(ctx.workspace.root), id, {
            url,
            ref,
            token,
            validate: async (staging) => {
                const dir = extensionRootOf(staging, path);
                const raw = await ctx.files.read(join(dir, "intentic-extension.json"));
                if (raw === undefined) {
                    throw new Error("not an intentic extension: no intentic-extension.json at the extension root");
                }
                const manifest = ExtensionManifestSchema.parse(JSON.parse(raw));
                // Prebuilt-dist rule: the sha the owner approved must BE the code that runs — no install-time build.
                if (manifest.entry !== undefined && (await ctx.files.read(join(dir, manifest.entry))) === undefined) {
                    throw new Error(`the manifest names entry "${manifest.entry}" but the checkout has no such file — commit the prebuilt bundle`);
                }
                // An image fragment must exist and be RUN/ENV-only: extensions can install tools but not claim
                // container privileges (those stay daemon-owned) or swap the base image.
                const fragmentPath = manifest.contributes?.environment?.fragment;
                if (fragmentPath !== undefined) {
                    const fragment = await ctx.files.read(join(dir, fragmentPath));
                    if (fragment === undefined) {
                        throw new Error(`the manifest names an environment fragment "${fragmentPath}" but the checkout has no such file`);
                    }
                    const offending = invalidExtensionFragment(fragment);
                    if (offending !== undefined) {
                        throw new Error(`the environment fragment may contain only RUN/ENV instructions — offending line: ${offending.trim()}`);
                    }
                }
            },
        });
        yield { kind: "log", message: "Extension installed — reload the app to load its UI; agent contributions load next turn." };
    },
    status: async (ctx, id, config) => {
        const { path } = config as ExtensionConfig;
        const dir = extensionDir(ctx.workspace.root, id);
        if ((await readExtensionManifest(extensionRootOf(dir, path))) === undefined) {
            return { state: "inactive" };
        }
        try {
            return { state: "active", detail: await ctx.git.head(dir) };
        } catch {
            return { state: "inactive" };
        }
    },
    remove: async (ctx, id, config) => {
        const { path } = config as ExtensionConfig;
        const dir = extensionDir(ctx.workspace.root, id);
        // Stop declared background processes before the checkout (and with it the manifest) disappears.
        const manifest = await readExtensionManifest(extensionRootOf(dir, path));
        for (const process of manifest?.contributes?.processes ?? []) {
            ctx.panels.stop(extensionProcessKey(id, process.name));
        }
        await ctx.files.remove(dir);
    },
};
