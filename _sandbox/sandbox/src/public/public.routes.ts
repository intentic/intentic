import { cp, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { publicContract, publicLabel, publicUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { SHARE_DIR } from "@intentic/sandbox-contract/share-paths";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { isPublicPath, toRelPath } from "@intentic/workspace-ignore";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { isControlPlanePath, resolveWithin } from "../workspace/workspace-files.js";
import { BLOCK_REASON, blockByName, listPublicFiles, publicRoot } from "./public-files.js";

/* The /public routes: the owner's side of the outbox, and the only authenticated view of it.
 *
 * `list` is the honest inventory, every file with its URL, and for the ones a guard refuses, the reason. That
 * pairing is the whole point: the serve path tells a stranger nothing (every refusal is the same 404, so the
 * outbox can't be probed), which only works because the publisher has a screen that tells them everything.
 *
 * `publish` COPIES. Moving would mean sharing a build output silently removed it from the repo that built it,
 * and the one gesture users repeat most is republishing the same path after a rebuild, which overwrites, by
 * design, so a link that was handed out keeps pointing at the current version. */

export type PublicRoutesDeps = Pick<Services, "config" | "ensurePreviewRoutes" | "workspace">;

// Percent-encode per segment, so a published "Q3 report.pdf" yields a URL that survives being pasted anywhere.
const fileUrl = (base: string | undefined, path: string): string | undefined =>
    base === undefined ? undefined : `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;

export const createPublicRoutes = (services: PublicRoutesDeps) => {
    const i = implement(publicContract).$context<OrpcContext>();
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    const slot = publicSlotFromToken(services.config.connectToken);
    const base = publicUrl(slot, zone, sandboxId);
    const root = publicRoot(services.workspace.root);

    return {
        list: i.list.handler(async () => ({
            ...(base === undefined ? {} : { url: base }),
            /* Shared conversations are in the outbox but not in this list. They are published by a different
             * gesture, listed with their own titles and dates by the /share routes, and withdrawn by their own
             * action, so a row here would be a second, worse handle on the same thing. And there would be
             * hundreds: the page's assets are one syntax grammar per file, and a file list that is nine parts
             * machinery is a file list nobody reads. */
            files: (await listPublicFiles(root))
                .filter((entry) => !entry.path.startsWith(`${SHARE_DIR}/`))
                .map((entry) => {
                    const file = { path: entry.path, size: entry.size, modifiedAt: entry.modifiedAt };
                    // A blocked file gets no URL: handing out a link that is guaranteed to 404 would read as
                    // the guard's failure rather than its verdict.
                    if (entry.blocked !== undefined) {
                        return Object.assign(file, { blocked: BLOCK_REASON[entry.blocked] });
                    }
                    const url = fileUrl(base, entry.path);
                    return url === undefined ? file : Object.assign(file, { url });
                }),
        })),

        publish: i.publish.handler(async ({ input }) => {
            const source = resolveWithin(services.workspace.root, input.path);
            if (source === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `"${input.path}" is not a path inside the workspace` });
            }
            // The control plane holds identity, provider tokens, private conversations, and logged-in browser
            // sessions. Publishing is the one gesture that would put them on the open internet, so it is refused
            // here as flatly as the generic file API refuses to read them.
            if (isControlPlanePath(services.workspace.root, source)) {
                throw new ORPCError("FORBIDDEN", { message: `"${input.path}" is sandbox-private state and can never be published` });
            }
            if (isPublicPath(toRelPath(services.workspace.root, source))) {
                throw new ORPCError("BAD_REQUEST", { message: `"${input.path}" is already published` });
            }
            const stats = await stat(source).catch(() => undefined);
            if (stats === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `"${input.path}" does not exist` });
            }
            const name = basename(source);
            // The outbox's one reserved name. A file published here would land among the shared conversations
            // (or, publishing a directory, on top of them) and be invisible in the list above, and the /share
            // routes would then be maintaining a tree somebody else is writing into.
            if (name === SHARE_DIR) {
                throw new ORPCError("BAD_REQUEST", { message: `"${SHARE_DIR}" is where shared conversations are published, rename it first` });
            }
            // Refuse the shapes the serve path would refuse anyway, at the gesture, where there is someone to
            // read the reason, instead of silently later when a recipient reports a dead link.
            const blocked = blockByName(name);
            if (blocked !== undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `"${name}" can't be published, ${BLOCK_REASON[blocked]}` });
            }
            await mkdir(root, { recursive: true });
            await cp(source, join(root, name), { recursive: true, force: true });
            // Almost always a memoized no-op, the boot sweep pre-mints the outbox label. It pays a platform
            // call only when boot ran with the platform unreachable, which is exactly when the first publish
            // would otherwise hand out a hostname that does not resolve.
            await services.ensurePreviewRoutes([publicLabel(slot)]);
            return { path: name, ...(fileUrl(base, name) === undefined ? {} : { url: fileUrl(base, name)! }) };
        }),

        unpublish: i.unpublish.handler(async ({ input }) => {
            const target = resolveWithin(root, input.path);
            if (target === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `"${input.path}" is not a published path` });
            }
            /* A shared conversation is withdrawn by its own action, which also drops it from the list the app
             * shows. Removing its page through here would leave a row promising a link that answers nothing.
             * Compared on the RESOLVED path, because that is the one the rm below takes: `./conversations` and
             * `x/../conversations` address the share root just as plainly as `conversations` does, and a guard
             * reading the raw input agrees with none of them, so either spelling would take out every published
             * page while the /share rows survive to promise links that answer nothing. */
            const shares = join(root, SHARE_DIR);
            if (target === shares || target.startsWith(shares + sep)) {
                throw new ORPCError("BAD_REQUEST", { message: "shared conversations are withdrawn from the Shared conversations list" });
            }
            await rm(target, { recursive: true, force: true });
            // Withdrawing the last file turns publishing off, because the outbox's existence is what "on" means.
            // Failure is not an error worth raising: nothing is published either way, and an outbox that lingers
            // empty is corrected by the next unpublish.
            const remaining = await readdir(root).catch(() => ["keep"]);
            if (remaining.length === 0) {
                await rmdir(root).catch(() => undefined);
            }
            return { ok: true } as const;
        }),
    };
};
