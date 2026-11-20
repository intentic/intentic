import { randomUUID } from "node:crypto";
import { BOOKMARK_ROOTS, type BookmarkNode, type BookmarkRoot } from "@intentic/sandbox-contract/schemas/bookmarks";
import { opt } from "../../opt.js";

// One profile's bookmarks as a tree held in memory: every node by id, and each folder's contents in their order. Pure;
// bookmarks-store.ts loads it, saves it after each change and tells every viewer. Read out depth first, the two roots
// first, which is also how it is saved, so the order within a folder is the order in the file.

// Why a change was refused, in the words a caller is told.
export class BookmarkRefusal extends Error {
    constructor(
        message: string,
        readonly missing: boolean = false,
    ) {
        super(message);
        this.name = "BookmarkRefusal";
    }
}

export interface NewBookmark {
    readonly kind: "url" | "folder";
    readonly title: string;
    readonly url?: string | undefined;
    readonly parent?: string | undefined;
    readonly index?: number | undefined;
    readonly favicon?: string | undefined;
}

/** A new node's id: short, and unique enough among one person's bookmarks. */
export const mintBookmarkId = (): string => `b${randomUUID().replaceAll("-", "").slice(0, 10)}`;

const ROOT_IDS: ReadonlySet<string> = new Set(BOOKMARK_ROOTS);
const isRoot = (id: string): id is BookmarkRoot => ROOT_IDS.has(id);

// The bar's own name and the other folder's, as stored; the editor names them in its own language.
const ROOT_TITLES = { bar: "Bookmarks bar", other: "Other bookmarks" } as const satisfies Readonly<Record<BookmarkRoot, string>>;

export class BookmarkTree {
    private readonly nodes = new Map<string, BookmarkNode>();
    private readonly children = new Map<string, string[]>();

    // From the saved depth-first list; the roots are made if the list lacks them, and a node whose folder is gone goes to
    // the other bookmarks rather than nowhere.
    constructor(saved: readonly BookmarkNode[] = [], now: number = Date.now()) {
        for (const root of BOOKMARK_ROOTS) {
            const kept = saved.find((node) => node.id === root);
            this.nodes.set(root, { id: root, kind: "folder", title: ROOT_TITLES[root], added: kept?.added ?? now });
            this.children.set(root, []);
        }
        for (const node of saved) {
            if (isRoot(node.id) || this.nodes.has(node.id)) {
                continue;
            }
            this.nodes.set(node.id, node);
            if (node.kind === "folder") {
                this.children.set(node.id, []);
            }
        }
        for (const node of saved) {
            if (isRoot(node.id)) {
                continue;
            }
            const parent = node.parent !== undefined && this.children.has(node.parent) && node.parent !== node.id ? node.parent : "other";
            this.nodes.set(node.id, { ...node, parent });
            this.children.get(parent)?.push(node.id);
        }
    }

    get size(): number {
        return this.nodes.size - BOOKMARK_ROOTS.length;
    }

    /** Every node, depth first: each root, then its contents in order, each folder's contents after it. */
    list(): BookmarkNode[] {
        const out: BookmarkNode[] = [];
        const walk = (id: string): void => {
            const node = this.nodes.get(id);
            if (node === undefined) {
                return;
            }
            out.push(node);
            for (const child of this.children.get(id) ?? []) {
                walk(child);
            }
        };
        for (const root of BOOKMARK_ROOTS) {
            walk(root);
        }
        return out;
    }

    get(id: string): BookmarkNode | undefined {
        return this.nodes.get(id);
    }

    private folder(id: string): string[] {
        const kids = this.children.get(id);
        if (kids === undefined) {
            throw new BookmarkRefusal(this.nodes.has(id) ? `${id} is a bookmark, not a folder` : `there is no folder ${id}`, !this.nodes.has(id));
        }
        return kids;
    }

    private node(id: string): BookmarkNode {
        const node = this.nodes.get(id);
        if (node === undefined) {
            throw new BookmarkRefusal(`there is no bookmark or folder ${id}`, true);
        }
        return node;
    }

    // Whether `folder` is `id` or inside it: where a folder cannot be moved.
    private within(folder: string, id: string): boolean {
        for (let at: string | undefined = folder; at !== undefined; at = this.nodes.get(at)?.parent) {
            if (at === id) {
                return true;
            }
        }
        return false;
    }

    private place(id: string, parent: string, index: number | undefined): void {
        const kids = this.folder(parent);
        const at = index === undefined ? kids.length : Math.min(Math.max(0, index), kids.length);
        kids.splice(at, 0, id);
    }

    private unplace(node: BookmarkNode): void {
        const kids = node.parent === undefined ? undefined : this.children.get(node.parent);
        const at = kids?.indexOf(node.id) ?? -1;
        if (kids !== undefined && at !== -1) {
            kids.splice(at, 1);
        }
    }

    add(input: NewBookmark, now: number, mint: () => string = mintBookmarkId): BookmarkNode {
        const parent = input.parent ?? "bar";
        this.folder(parent);
        if (input.kind === "url" && (input.url === undefined || input.url === "")) {
            throw new BookmarkRefusal("a bookmark needs an address");
        }
        const node: BookmarkNode = {
            id: mint(),
            kind: input.kind,
            title: input.title,
            parent,
            added: now,
            ...opt("url", input.kind === "url" ? input.url : undefined),
            ...opt("favicon", input.kind === "url" ? input.favicon : undefined),
        };
        this.nodes.set(node.id, node);
        if (node.kind === "folder") {
            this.children.set(node.id, []);
        }
        this.place(node.id, parent, input.index);
        return node;
    }

    edit(id: string, change: { readonly title?: string | undefined; readonly url?: string | undefined; readonly parent?: string | undefined }): BookmarkNode {
        const node = this.node(id);
        if (isRoot(id)) {
            throw new BookmarkRefusal("the bookmarks bar and the other bookmarks keep their place and their names");
        }
        const edited: BookmarkNode = {
            ...node,
            ...opt("title", change.title),
            ...opt("url", node.kind === "url" && change.url !== undefined && change.url !== "" ? change.url : undefined),
        };
        this.nodes.set(id, edited);
        return change.parent === undefined || change.parent === node.parent ? edited : this.move(id, change.parent, undefined);
    }

    move(id: string, parent: string, index: number | undefined): BookmarkNode {
        const node = this.node(id);
        if (isRoot(id)) {
            throw new BookmarkRefusal("the bookmarks bar and the other bookmarks keep their place and their names");
        }
        this.folder(parent);
        if (node.kind === "folder" && this.within(parent, id)) {
            throw new BookmarkRefusal("a folder cannot go inside itself");
        }
        this.unplace(node);
        const moved: BookmarkNode = { ...node, parent };
        this.nodes.set(id, moved);
        this.place(id, parent, index);
        return moved;
    }

    /** Takes out a bookmark, or a folder and everything in it; answers whether anything was there. */
    remove(id: string): boolean {
        const node = this.nodes.get(id);
        if (node === undefined) {
            return false;
        }
        if (isRoot(id)) {
            throw new BookmarkRefusal("the bookmarks bar and the other bookmarks keep their place and their names");
        }
        this.unplace(node);
        const drop = (gone: string): void => {
            for (const child of this.children.get(gone) ?? []) {
                drop(child);
            }
            this.children.delete(gone);
            this.nodes.delete(gone);
        };
        drop(id);
        return true;
    }
}
