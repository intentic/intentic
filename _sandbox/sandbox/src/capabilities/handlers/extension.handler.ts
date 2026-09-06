import { join } from "node:path";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { ExtensionConfig } from "@intentic/sandbox-contract";
import { invalidExtensionFragment } from "@intentic/sandbox-contract";
import { extensionProcessKey } from "../../extensions/extension-processes.js";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import type { CapabilityHandler } from "../capability.js";
import { extensionDir, extensionRootOf, extensionsRoot, readExtensionManifest } from "../extension-dirs.js";
import { checkoutInto, previousDir } from "../git-checkout.js";

// An intentic extension: a git checkout at .intentic/local/extensions/<id>, sha-pinned by construction (the config
// schema requires a full commit sha, so the owner approves EXACTLY the code that runs; an update is an explicit
// re-add at a new sha). Install validates the manifest and the prebuilt entry bundle BEFORE the staged checkout
// goes live, so a broken extension never replaces a working one; an update stops the outgoing checkout's
// declared processes at the swap (they'd otherwise keep executing the replaced code until a reboot) and sets
// that checkout aside one version deep, which is what the extensions revert route swaps back. The extensions
// routes serve the manifest list + bundle; agent contributions ride extensionAgentDirsOf into the SDK's plugin
// loader.
export const extensionHandler: CapabilityHandler = {
    secret: (config) => ((config as ExtensionConfig).token !== undefined ? "token" : undefined),
    /* `registry` is echoed because it is not a credential and never was: the address of a public catalogue.
     * Withholding it cost far more than a missing label: secret-fields.ts derives the credential keys as the
     * COMPLEMENT of this echo, so an unechoed field is vaulted and the manifest keeps the marker in its place,
     * and the marker is not a url, so every install from the registry catalogue (which always attaches the
     * registry it browsed) wrote an entry that failed CapabilitySchema on the very next read and was skipped as
     * unreadable. The extension then had no capability entry to be enumerated from: no row, no switch, no
     * views, no bin, no agent plugin. An echo is a claim about what the browser may see, and here it is also
     * the claim that decides what leaves the file, so a field that is merely uninteresting must still be named. */
    echo: (config) => {
        const extension = config as ExtensionConfig;
        return {
            url: extension.url,
            ref: extension.ref,
            ...(extension.path !== undefined ? { path: extension.path } : {}),
            ...(extension.registry !== undefined ? { registry: extension.registry } : {}),
            hasToken: extension.token !== undefined,
        };
    },
    /* `reapply: false` for the plugin handler's reason and one more: this kind's apply re-clones, so re-running
     * it to change a label would fetch code the owner already has. The checkout moves instead, with the version
     * kept aside for a revert; the processes declared by the old name are stopped, since their keys carry it
     * and the reconcile that follows starts them under the new one. */
    rename: {
        reapply: false,
        carry: async (ctx, from, to, config) => {
            const root = extensionsRoot(ctx.workspace.root);
            const manifest = await readExtensionManifest(extensionRootOf(extensionDir(ctx.workspace.root, from), (config as ExtensionConfig).path));
            for (const process of manifest?.contributes?.processes ?? []) {
                ctx.serviceProcesses.stop(extensionProcessKey(from, process.name));
            }
            await ctx.files.move(extensionDir(ctx.workspace.root, from), extensionDir(ctx.workspace.root, to));
            await ctx.files.move(previousDir(root, from), previousDir(root, to)).catch(() => undefined);
        },
    },
    async *apply(ctx, id, config) {
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
            // An update keeps the outgoing checkout one version deep (the revert route's subject); on a first
            // install there is nothing to keep and this is a no-op.
            keepPrevious: true,
            /* The quiesce step: stop the OUTGOING checkout's declared processes before its directory is
             * replaced. Without this an updated extension's gateway keeps executing the previous release until
             * a reboot, `processes.start` is a no-op against a running session, so the post-apply autoStart
             * seam alone cannot cycle them. The old manifest is read at the old config's `path` (the update may
             * move it), via the store because the route upserts the new config only after apply succeeds. */
            beforeSwap: async () => {
                const current = await ctx.capabilities.get(id);
                const livePath = current?.kind === "extension" ? current.config.path : path;
                const outgoing = await readExtensionManifest(extensionRootOf(extensionDir(ctx.workspace.root, id), livePath));
                for (const process of outgoing?.contributes?.processes ?? []) {
                    ctx.serviceProcesses.stop(extensionProcessKey(id, process.name));
                }
            },
            validate: async (staging) => {
                const dir = extensionRootOf(staging, path);
                const raw = await ctx.files.read(join(dir, "intentic-extension.json"));
                if (raw === undefined) {
                    throw new Error("not an intentic extension: no intentic-extension.json at the extension root");
                }
                const manifest = ExtensionManifestSchema.parse(JSON.parse(raw));
                // Prebuilt-dist rule: the sha the owner approved must BE the code that runs, no install-time build.
                if (manifest.entry !== undefined && (await ctx.files.read(join(dir, manifest.entry))) === undefined) {
                    throw new Error(`the manifest names entry "${manifest.entry}" but the checkout has no such file: commit the prebuilt bundle`);
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
                        throw new Error(`the environment fragment may contain only RUN/ENV instructions, offending line: ${offending.trim()}`);
                    }
                }
            },
        });
        yield { kind: "log", message: "Extension installed, reload the app to load its UI; agent contributions load next turn." };
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
            ctx.serviceProcesses.stop(extensionProcessKey(id, process.name));
        }
        await ctx.files.remove(dir);
        // The kept-aside previous version goes with it, a removed extension has nothing to revert to.
        await ctx.files.remove(previousDir(extensionsRoot(ctx.workspace.root), id));
    },
};
