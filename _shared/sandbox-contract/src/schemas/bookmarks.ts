// bookmarks: the pages a browser profile keeps on purpose, in folders, in the order the person put them. One tree per
// profile, like the history beside it (schemas/browsing.ts); the person's own window's is `_own`.
import { z } from "zod";
import { BrowsingProfileSchema } from "./browsing.js";

// The two folders every tree has and nobody removes: the bar under the toolbar, and everything else.
export const BOOKMARK_ROOTS = ["bar", "other"] as const;
export type BookmarkRoot = (typeof BOOKMARK_ROOTS)[number];

// A site's icon as a tab carried it: a small picture in a data: URL, never an address to fetch.
const FaviconSchema = z
    .string()
    .max(64 * 1024)
    .regex(/^data:image\//)
    .describe("The site's icon as a data: URL, as the tab carried it when the page was kept.");

export const BookmarkNodeSchema = z.object({
    id: z.string().describe("The bookmark's or folder's id, stable for its life: what editing, moving and removing take."),
    kind: z.enum(["url", "folder"]).describe("A page, or a folder of them."),
    title: z.string().describe("What it is called: a page's title as kept or renamed, or the folder's name."),
    url: z.string().optional().describe("Where a page bookmark goes. Absent for a folder."),
    parent: z.string().optional().describe("The folder it is in. Absent only for the two roots, `bar` and `other`."),
    added: z.number().describe("When it was added, in milliseconds."),
    favicon: FaviconSchema.optional(),
});
export type BookmarkNode = z.infer<typeof BookmarkNodeSchema>;

export const BookmarksQuerySchema = z.object({ profile: BrowsingProfileSchema });
export type BookmarksQuery = z.infer<typeof BookmarksQuerySchema>;

export const BookmarksSchema = z.object({
    profile: z.string().describe("Whose bookmarks these are."),
    nodes: z
        .array(BookmarkNodeSchema)
        .describe("Every folder and bookmark, the two roots first, each folder's contents in their order after it (depth first)."),
});
export type Bookmarks = z.infer<typeof BookmarksSchema>;

const TitleSchema = z.string().max(500);
const UrlSchema = z.string().min(1).max(4096);

export const BookmarkAddSchema = z.object({
    profile: BrowsingProfileSchema,
    kind: z.enum(["url", "folder"]).describe("A page, or a new folder."),
    title: TitleSchema.describe("Its name: the page's title for a page, or the new folder's."),
    url: UrlSchema.optional().describe("The page's address; required for a page, ignored for a folder."),
    parent: z.string().optional().describe("The folder to put it in. Absent puts it on the bookmarks bar."),
    index: z.number().int().nonnegative().optional().describe("Where in that folder, counting from 0. Absent puts it last."),
    favicon: FaviconSchema.optional(),
});
export type BookmarkAdd = z.infer<typeof BookmarkAddSchema>;

export const BookmarkEditSchema = z.object({
    profile: BrowsingProfileSchema,
    id: z.string().describe("Which bookmark or folder."),
    title: TitleSchema.optional().describe("Its new name. Absent keeps it."),
    url: UrlSchema.optional().describe("A page's new address. Absent keeps it; ignored for a folder."),
    parent: z.string().optional().describe("A folder to move it into, at the end. Absent keeps it where it is."),
});
export type BookmarkEdit = z.infer<typeof BookmarkEditSchema>;

export const BookmarkMoveSchema = z.object({
    profile: BrowsingProfileSchema,
    id: z.string().describe("Which bookmark or folder."),
    parent: z.string().describe("The folder it goes into, which may be the one it is in."),
    index: z.number().int().nonnegative().describe("Its place there, counting from 0, among what the folder holds without it."),
});
export type BookmarkMove = z.infer<typeof BookmarkMoveSchema>;

export const BookmarkRemoveSchema = z.object({
    profile: BrowsingProfileSchema,
    id: z.string().describe("Which bookmark, or which folder: a folder goes with everything in it."),
});
export type BookmarkRemove = z.infer<typeof BookmarkRemoveSchema>;

export const BookmarkChangedSchema = z.object({
    node: BookmarkNodeSchema.optional().describe("The bookmark or folder as it now stands. Absent after a removal."),
});
export type BookmarkChanged = z.infer<typeof BookmarkChangedSchema>;
