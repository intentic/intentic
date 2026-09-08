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

// oRPC route table for the knowledge base, in the extension's namespace. Non-GET routes take `{ path }` in the JSON
// body; GET routes carry it on the query.
export const knowledgeContract = {
    overview: oc.route({ method: "GET", path: "/overview" }).output(OverviewSchema),
    notes: oc.route({ method: "GET", path: "/notes" }).output(z.object({ notes: z.array(NoteSchema.shape.summary) })),
    search: oc.route({ method: "GET", path: "/search" }).input(SearchQuerySchema).output(SearchResultSchema),
    note: oc.route({ method: "GET", path: "/note" }).input(NoteQuerySchema).output(NoteSchema),
    graph: oc.route({ method: "GET", path: "/graph" }).input(GraphQuerySchema).output(GraphSchema),
    write: oc.route({ method: "PUT", path: "/note" }).input(NoteWriteSchema).output(OkSchema),
    delete: oc.route({ method: "DELETE", path: "/note" }).input(NoteQuerySchema).output(OkSchema),
    // Owner-initiated only, from the empty state; never triggered by a read.
    seed: oc.route({ method: "POST", path: "/seed" }).output(SeedResultSchema),
};
