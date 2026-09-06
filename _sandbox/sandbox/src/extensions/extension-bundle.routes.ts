import { join } from "node:path";
import type { Context } from "hono";
import { extensionDir, extensionRead } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { sha256Text } from "../workspace/files/workspace-files.js";
import { installedExtensions } from "./installed-extensions.js";

export type ExtensionBundleRouteDeps = Pick<Services, "workspace" | "files" | "capabilities" | "config" | "git">;

// GET /extensions/:id/bundle. An extension's prebuilt ESM bundle, raw JS bytes, so a plain Hono route like
// /environment (oRPC is for JSON). The web loader fetches this with auth → Blob URL → import(). The ETag is the
// code identity: the pinned HEAD sha for a git-installed extension (sha-pinned installs make the bundle
// immutable per commit), and the content hash for a workspace one, whose dir is live-edited and has no commit
// to stand for it.
export const createExtensionBundleRoute =
    (services: ExtensionBundleRouteDeps) =>
    async (c: Context<AppEnv, "/extensions/:id/bundle">): Promise<Response> => {
        const id = c.req.param("id");
        const extension = (await installedExtensions(services)).find((entry) => entry.id === id);
        if (extension === undefined) {
            return c.json({ error: "no extension with that id" }, 404);
        }
        if (extension.manifest.entry === undefined) {
            return c.json({ error: "the extension has no UI entry" }, 404);
        }
        const source = await extensionRead(join(extension.dir, extension.manifest.entry));
        if (source === undefined) {
            return c.json({ error: "the entry bundle is missing from the extension" }, 404);
        }
        const etag = extension.source === "installed" ? await services.git.head(extensionDir(services.workspace.root, id)) : sha256Text(source);
        if (c.req.header("if-none-match") === etag) {
            return c.body(null, 304);
        }
        return c.body(source, 200, { "content-type": "text/javascript; charset=utf-8", etag });
    };
