import { cp, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { publicContract, publicUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { SHARE_DIR } from "@intentic/sandbox-contract/share-paths";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { isPublicPath, toRelPath } from "@intentic/workspace-ignore";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { isControlPlanePath, resolveWithin } from "../workspace/files/workspace-files-paths.js";
import { BLOCK_REASON, blockByName, listPublicFiles, publicRoot } from "./public-files.js";

// The /public routes: the owner's authenticated view of the outbox; `list` reports every file with its URL or its
// refusal reason, while the serve path answers every refusal with the same 404. `publish` copies rather than moves, so
// republishing a path overwrites and existing links keep working.

export type PublicRoutesDeps = Pick<Services, "config" | "workspace">;

// Percent-encodes each path segment separately, not the whole path.
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
            // Shared conversations live in the outbox but are listed and withdrawn through the /share routes, not here.
            files: (await listPublicFiles(root))
                .filter((entry) => !entry.path.startsWith(`${SHARE_DIR}/`))
                .map((entry) => {
                    const file = { path: entry.path, size: entry.size, modifiedAt: entry.modifiedAt };
                    // A blocked file omits its URL rather than link to a guaranteed 404.
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
            // The control plane holds identity, provider tokens and private state and can never be published.
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
            // SHARE_DIR is reserved for shared conversations; publishing over it would hide files from this list.
            if (name === SHARE_DIR) {
                throw new ORPCError("BAD_REQUEST", { message: `"${SHARE_DIR}" is where shared conversations are published, rename it first` });
            }
            // Rejects up front what the serve path would refuse anyway, instead of failing silently for a later
            // recipient.
            const blocked = blockByName(name);
            if (blocked !== undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `"${name}" can't be published, ${BLOCK_REASON[blocked]}` });
            }
            await mkdir(root, { recursive: true });
            await cp(source, join(root, name), { recursive: true, force: true });
            return { path: name, ...(fileUrl(base, name) === undefined ? {} : { url: fileUrl(base, name)! }) };
        }),

        unpublish: i.unpublish.handler(async ({ input }) => {
            const target = resolveWithin(root, input.path);
            if (target === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `"${input.path}" is not a published path` });
            }
            // Compares the resolved path, matching what rm takes below; shared conversations are withdrawn via their
            // own action, not here.
            const shares = join(root, SHARE_DIR);
            if (target === shares || target.startsWith(shares + sep)) {
                throw new ORPCError("BAD_REQUEST", { message: "shared conversations are withdrawn from the Shared conversations list" });
            }
            await rm(target, { recursive: true, force: true });
            // Emptying the outbox turns publishing off; a failed cleanup self-heals on the next unpublish.
            const remaining = await readdir(root).catch(() => ["keep"]);
            if (remaining.length === 0) {
                await rmdir(root).catch(() => undefined);
            }
            return { ok: true } as const;
        }),
    };
};
