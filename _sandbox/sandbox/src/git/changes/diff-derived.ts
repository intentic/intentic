import { basename, isAbsolute, relative, sep } from "node:path";
import { type DerivedSide, diffContract, type DiffSourceQuery } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import type { OrpcContext } from "../../app-env.js";
import { type BlobLocation, createDiffLocator, DiffLocateError, type Which } from "./diff-locate.js";

// Both sides of a document's diff as text, the twin of /diff/raw: the same locator finds each side, and fileq renders
// what it finds (derived-blob.ts). Sides render concurrently; an absent side is absent, a side nothing reads says why.

const ORPC_CODE = { 400: "BAD_REQUEST", 404: "NOT_FOUND", 413: "PAYLOAD_TOO_LARGE" } as const;

export const createDiffRoutes = (services: Services) => {
    const i = implement(diffContract).$context<OrpcContext>();
    const locator = createDiffLocator(services);

    // Only a location inside the shared tree has a shadow of its own to reuse; an agent's checkout is never shadowed.
    const shadowPath = (located: BlobLocation): string | undefined => {
        if (!("file" in located)) {
            return undefined;
        }
        const rel = relative(services.workspace.root, located.file);
        return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel.split(sep).join("/");
    };

    // One side rendered, or nothing when the diff has no such side. Refusals of the whole query (an unknown repo or
    // agent, a path outside its repo) surface as the call's error; a side that is merely not there is not one.
    const side = async (query: DiffSourceQuery, which: Which): Promise<DerivedSide | undefined> => {
        const located = await locator.locate(query, which);
        if (located === undefined) {
            return undefined;
        }
        let bytes: Buffer;
        try {
            bytes = await locator.read(located);
        } catch (error) {
            if (error instanceof DiffLocateError && error.status === 404) {
                return undefined;
            }
            if (error instanceof DiffLocateError && error.status === 413) {
                return { present: false, reason: "this version is too large to render as text" };
            }
            throw error;
        }
        const relPath = shadowPath(located);
        return services.derived.deriveBytes(services.workspace.root, bytes, { name: basename(query.path), ...(relPath === undefined ? {} : { relPath }) });
    };

    return i.router({
        derived: i.derived.handler(async ({ input }) => {
            try {
                const [before, after] = await Promise.all([side(input, "before"), side(input, "after")]);
                return { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
            } catch (error) {
                if (error instanceof DiffLocateError) {
                    throw new ORPCError(ORPC_CODE[error.status], { message: error.message });
                }
                throw error;
            }
        }),
    });
};
