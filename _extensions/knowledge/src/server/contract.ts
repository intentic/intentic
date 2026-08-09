import { oc } from "@orpc/contract";
import {
    GraphQuerySchema,
    GraphSchema,
    NoteQuerySchema,
    NoteSchema,
    NoteWriteSchema,
    OkSchema,
    OverviewSchema,
    SearchQuerySchema,
    SearchResultSchema,
    SeedResultSchema,
} from "../contract.js";
import { z } from "zod";

/* The knowledge vault's routes, in the extension's own namespace. oRPC's OpenAPI codec reads non-GET input from
 * the JSON body, so write and delete send `{ path }` in the body while the reads carry it on the query.
 *
 * `search` rather than a list route with client-side filtering: the vault is on the daemon's disk, the index is
 * built there, and shipping every note's body to the browser so it could grep them would be the same work done
 * twice in the slower place. `notes` exists beside it for the surfaces that want the whole set (the picker's
 * groups, the counts) and carries summaries only. */
export const knowledgeContract = {
    overview: oc.route({ method: "GET", path: "/overview" }).output(OverviewSchema),
    notes: oc.route({ method: "GET", path: "/notes" }).output(z.object({ notes: z.array(NoteSchema.shape.summary) })),
    search: oc.route({ method: "GET", path: "/search" }).input(SearchQuerySchema).output(SearchResultSchema),
    note: oc.route({ method: "GET", path: "/note" }).input(NoteQuerySchema).output(NoteSchema),
    graph: oc.route({ method: "GET", path: "/graph" }).input(GraphQuerySchema).output(GraphSchema),
    write: oc.route({ method: "PUT", path: "/note" }).input(NoteWriteSchema).output(OkSchema),
    delete: oc.route({ method: "DELETE", path: "/note" }).input(NoteQuerySchema).output(OkSchema),
    // Owner-initiated, from the empty state — never on a read. A vault appearing in somebody's workspace
    // because they looked at a panel is a surprise; a vault appearing because they pressed "start it off" is
    // the feature.
    seed: oc.route({ method: "POST", path: "/seed" }).output(SeedResultSchema),
};
