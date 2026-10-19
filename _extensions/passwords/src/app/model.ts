import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import type { PasswordCategory, PasswordItem, PasswordRequest } from "./port.js";

// THE APP'S LIST, as a pure function of what the port said: which category a password falls in, what the index's
// filters hold, what a search finds, and the order rows are drawn in. No Vue, no I/O, so every rule here is a test.

const TERMINAL: ReadonlySet<KeyringOrigin["kind"]> = new Set(["ssh", "ssh-key", "sudo", "git", "prompt"]);

/** Where a password belongs, by the first place it works: a site, a program, a terminal prompt, a phone app; text with none is a note. */
export const categoryOf = (origins: readonly KeyringOrigin[], kind: "password" | "text"): PasswordCategory => {
    const first = origins[0];
    if (first === undefined) {
        return kind === "text" ? "note" : "site";
    }
    if (first.kind === "site") {
        return "site";
    }
    if (first.kind === "program") {
        return "app";
    }
    if (first.kind === "package") {
        return "phone";
    }
    return TERMINAL.has(first.kind) ? "terminal" : "site";
};

/** One index entry: a kind, a sandbox's grants, or one of the Attention filters. */
export type PasswordFilter =
    | { readonly kind: "all" }
    | { readonly kind: "category"; readonly category: PasswordCategory }
    | { readonly kind: "sandbox"; readonly url: string }
    | { readonly kind: "fresh" }
    | { readonly kind: "requests" }
    | { readonly kind: "weak" };

/** The filter as the URL carries it: `all`, `site`, `fresh`, `sandbox:https://…`. */
export const filterKey = (filter: PasswordFilter): string => {
    switch (filter.kind) {
        case "category":
            return filter.category;
        case "sandbox":
            return `sandbox:${filter.url}`;
        default:
            return filter.kind;
    }
};

const CATEGORIES: ReadonlySet<string> = new Set<PasswordCategory>(["site", "app", "terminal", "phone", "note"]);

export const filterOf = (key: string | undefined): PasswordFilter => {
    if (key === undefined || key === "" || key === "all") {
        return { kind: "all" };
    }
    if (key.startsWith("sandbox:")) {
        return { kind: "sandbox", url: key.slice("sandbox:".length) };
    }
    if (key === "fresh" || key === "requests" || key === "weak") {
        return { kind: key };
    }
    // SAFETY: CATEGORIES holds exactly the PasswordCategory values, and `has` just said `key` is one of them.
    return CATEGORIES.has(key) ? { kind: "category", category: key as PasswordCategory } : { kind: "all" };
};

const passes = (item: PasswordItem, filter: PasswordFilter): boolean => {
    switch (filter.kind) {
        case "all":
        case "requests":
            return true;
        case "category":
            return item.category === filter.category;
        case "sandbox":
            return item.access.some((access) => access.sandbox.url === filter.url);
        case "fresh":
            return item.fresh;
        case "weak":
            return item.health?.weak === true || item.health?.reused === true;
    }
};

const originText = (origin: KeyringOrigin): string => {
    switch (origin.kind) {
        case "site":
            return origin.host;
        case "program":
            return `${origin.program} ${origin.label ?? ""}`;
        case "package":
            return `${origin.package} ${origin.label ?? ""}`;
        case "ssh":
            return `ssh ${origin.target}`;
        case "ssh-key":
            return `ssh ${origin.path}`;
        case "sudo":
            return `sudo ${origin.user ?? ""}`;
        case "git":
            return `git ${origin.url}`;
        case "prompt":
            return `${origin.command ?? ""} ${origin.text}`;
    }
};

/** Every word a search may find a password by: its title, name, user, places, note and the computer it is on. */
export const searchText = (item: PasswordItem): string =>
    [item.title, item.name, item.username ?? "", item.note ?? "", item.computer ?? "", ...item.origins.map(originText)].join(" ").toLowerCase();

/** Each word of the query must appear somewhere: "git radar" finds `git github.com` for user radarsu. */
export const matchesQuery = (item: PasswordItem, query: string): boolean => {
    const words = query.toLowerCase().split(/\s+/u).filter((word) => word !== "");
    if (words.length === 0) {
        return true;
    }
    const text = searchText(item);
    return words.every((word) => text.includes(word));
};

const byTitle = (a: PasswordItem, b: PasswordItem): number => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name);

/**
 * The rows for one filter and query. "Just saved" is newest first, by when it was seen; every other list is by title,
 * a person's own order for finding a name they know.
 */
export const visibleItems = (items: readonly PasswordItem[], filter: PasswordFilter, query: string): PasswordItem[] => {
    const rows = items.filter((item) => passes(item, filter) && matchesQuery(item, query));
    return filter.kind === "fresh" ? rows.sort((a, b) => (b.captured?.at ?? b.updatedAt) - (a.captured?.at ?? a.updatedAt)) : rows.sort(byTitle);
};

/** The counts beside each index entry. */
export interface IndexCounts {
    readonly all: number;
    readonly category: Readonly<Record<PasswordCategory, number>>;
    readonly sandbox: ReadonlyMap<string, number>;
    readonly fresh: number;
    readonly weak: number;
    readonly requests: number;
}

export const indexCounts = (items: readonly PasswordItem[], requests: readonly PasswordRequest[]): IndexCounts => {
    const category = { site: 0, app: 0, terminal: 0, phone: 0, note: 0 } satisfies Record<PasswordCategory, number>;
    const sandbox = new Map<string, number>();
    for (const item of items) {
        category[item.category] += 1;
        for (const access of item.access) {
            sandbox.set(access.sandbox.url, (sandbox.get(access.sandbox.url) ?? 0) + 1);
        }
    }
    return {
        all: items.length,
        category,
        sandbox,
        fresh: items.filter((item) => item.fresh).length,
        weak: items.filter((item) => item.health?.weak === true || item.health?.reused === true).length,
        requests: requests.length,
    };
};

/** The strip above the list: what was saved in the last week, newest first, while any of it is still fresh. */
export const recentlySaved = (items: readonly PasswordItem[], now: number, days = 7): PasswordItem[] =>
    items
        .filter((item) => item.fresh && item.captured !== undefined && now - item.captured.at <= days * 86_400_000)
        .sort((a, b) => (b.captured?.at ?? 0) - (a.captured?.at ?? 0));
