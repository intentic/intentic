import { join } from "node:path";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import type { ExtensionConfig } from "@intentic/sandbox-contract";
import { invalidExtensionFragment } from "@intentic/sandbox-contract";
import { extensionProcessKey } from "../../extensions/extension-processes.js";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import type { CapabilityHandler } from "../capability.js";
import { extensionDir, extensionRootOf, extensionsRoot, readExtensionManifest } from "../extension-dirs.js";
import { checkoutInto, previousDir } from "../git-checkout.js";

// A git checkout at .intentic/local/extensions/<id>, sha-pinned by the schema (a full commit sha). Install validates
// the manifest and entry bundle before the checkout goes live, so a broken extension never replaces a working one. An
// update stops the outgoing processes at the swap, kept one version deep for revert.
export const extensionHandler: CapabilityHandler = {
    secret: (config) => ((config as ExtensionConfig).token !== undefined ? "token" : undefined),
    // `registry` is echoed though harmless: secret-fields.ts vaults whatever this doesn't echo, and a vaulted
    // `registry` (not a url) fails CapabilitySchema on the next read, deleting the whole entry.
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
    // `reapply: false`: apply re-clones, so re-running it just to rename would refetch code already present. The
    // checkout moves instead; old-name processes stop since their keys carry it, reconcile restarts them under the new
    // name.
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
            // Keeps the outgoing checkout one version deep, for revert; a no-op on a first install.
            keepPrevious: true,
            // Quiesce: stops the outgoing checkout's processes before its directory is replaced (a no-op restart can't
            // cycle a still-running one). Reads the old manifest at the stored config's `path`, before the route's
            // upsert lands.
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
                // Prebuilt-dist rule: the sha the owner approved must be the code that runs, no install-time build.
                if (manifest.entry !== undefined && (await ctx.files.read(join(dir, manifest.entry))) === undefined) {
                    throw new Error(`the manifest names entry "${manifest.entry}" but the checkout has no such file: commit the prebuilt bundle`);
                }
                // Fragment must be RUN/ENV only: extensions install tools, never claim privileges or swap the base
                // image.
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
        // Stops declared background processes before the checkout, and its manifest, disappear.
        const manifest = await readExtensionManifest(extensionRootOf(dir, path));
        for (const process of manifest?.contributes?.processes ?? []) {
            ctx.serviceProcesses.stop(extensionProcessKey(id, process.name));
        }
        await ctx.files.remove(dir);
        // The kept-aside previous version goes too: a removed extension has nothing left to revert to.
        await ctx.files.remove(previousDir(extensionsRoot(ctx.workspace.root), id));
    },
};
