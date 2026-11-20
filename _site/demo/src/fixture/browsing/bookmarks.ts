import type { BookmarkAdd, BookmarkChanged, BookmarkEdit, BookmarkMove, BookmarkNode, BookmarkRemove, Bookmarks } from "@intentic/sandbox-contract/schemas/bookmarks";

// The visitor's own bookmarks (`_own`): a few on the bar, a work folder with one inside it, and a couple elsewhere, with
// icons drawn the way a tab carries one (a small picture in a data: URL). Every change happens to this record for the rest
// of the visit, and is pushed as the daemon pushes it (`bookmarks`), so the star, the bar and the manager agree.

// A site's icon: a rounded square in its colour with its letter, as small as a tab's.
const icon = (letter: string, colour: string): string =>
    `data:image/svg+xml;base64,${btoa(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${colour}"/><text x="8" y="12" font-family="sans-serif" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`,
    )}`;

const DAY = 86_400_000;
const at = Date.now();

const seed = (): BookmarkNode[] => [
    { id: `bar`, kind: `folder`, title: `Bookmarks bar`, added: at - 90 * DAY },
    { id: `bk-fritz`, kind: `url`, title: `FRITZ!Box`, url: `http://192.168.0.168/`, parent: `bar`, added: at - 60 * DAY, favicon: icon(`F`, `#d9372b`) },
    { id: `bk-gh`, kind: `url`, title: `GitHub`, url: `https://github.com/`, parent: `bar`, added: at - 50 * DAY, favicon: icon(`G`, `#24292f`) },
    { id: `bk-work`, kind: `folder`, title: `Work`, parent: `bar`, added: at - 40 * DAY },
    {
        id: `bk-prs`,
        kind: `url`,
        title: `Pull requests · intentic/intentic`,
        url: `https://github.com/intentic/intentic/pulls`,
        parent: `bk-work`,
        added: at - 30 * DAY,
        favicon: icon(`G`, `#24292f`),
    },
    { id: `bk-stripe`, kind: `url`, title: `Stripe dashboard`, url: `https://dashboard.stripe.com/`, parent: `bk-work`, added: at - 20 * DAY, favicon: icon(`S`, `#635bff`) },
    { id: `bk-vue`, kind: `url`, title: `Vue.js guide`, url: `https://vuejs.org/guide/introduction.html`, parent: `bar`, added: at - 10 * DAY, favicon: icon(`V`, `#42b883`) },
    { id: `bk-hn`, kind: `url`, title: `Hacker News`, url: `https://news.ycombinator.com/`, parent: `bar`, added: at - 5 * DAY, favicon: icon(`Y`, `#ff6600`) },
    { id: `other`, kind: `folder`, title: `Other bookmarks`, added: at - 90 * DAY },
    { id: `bk-mdn`, kind: `url`, title: `CSS flexible box layout - MDN`, url: `https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout`, parent: `other`, added: at - 3 * DAY, favicon: icon(`M`, `#1b1b1b`) },
    { id: `bk-recipes`, kind: `url`, title: `Pierogi recipe`, url: `https://food.example/pierogi`, parent: `other`, added: at - 2 * DAY },
];

// By profile; only the visitor's own window keeps any.
const trees = new Map<string, BookmarkNode[]>([[`_own`, seed()]]);
let minted = 0;

const treeOf = (profile: string): BookmarkNode[] => {
    const held = trees.get(profile) ?? [
        { id: `bar`, kind: `folder`, title: `Bookmarks bar`, added: at },
        { id: `other`, kind: `folder`, title: `Other bookmarks`, added: at },
    ];
    trees.set(profile, held);
    return held;
};

// Depth first, the roots first, as the daemon lists them.
const ordered = (nodes: readonly BookmarkNode[]): BookmarkNode[] => {
    const out: BookmarkNode[] = [];
    const walk = (id: string): void => {
        for (const node of nodes.filter((candidate) => candidate.parent === id)) {
            out.push(node);
            walk(node.id);
        }
    };
    for (const root of nodes.filter((node) => node.parent === undefined)) {
        out.push(root);
        walk(root.id);
    }
    return out;
};

const placed = (nodes: BookmarkNode[], node: BookmarkNode, parent: string, index: number | undefined): BookmarkNode[] => {
    const without = ordered(nodes).filter((candidate) => candidate.id !== node.id);
    const siblings = without.filter((candidate) => candidate.parent === parent);
    const before = siblings[index ?? siblings.length];
    const moved = { ...node, parent };
    const slot = before === undefined ? without.length : without.indexOf(before);
    // Last in the folder: just after its last node and everything inside that.
    const end = siblings.length === 0 ? without.findIndex((candidate) => candidate.id === parent) + 1 : without.indexOf(siblings.at(-1) ?? node) + 1;
    without.splice(before === undefined ? end : slot, 0, moved);
    return ordered(without);
};

export const demoBookmarks = (profile: string): Bookmarks => ({ profile, nodes: ordered(treeOf(profile)) });

export const demoAddBookmark = (input: BookmarkAdd): BookmarkChanged => {
    minted += 1;
    const node: BookmarkNode = { id: `bk-new-${minted}`, kind: input.kind, title: input.title, parent: input.parent ?? `bar`, added: Date.now() };
    if (input.kind === `url` && input.url !== undefined) {
        node.url = input.url;
    }
    if (input.favicon !== undefined) {
        node.favicon = input.favicon;
    }
    trees.set(input.profile, placed(treeOf(input.profile), node, node.parent ?? `bar`, input.index));
    return { node };
};

export const demoEditBookmark = (input: BookmarkEdit): BookmarkChanged => {
    const nodes = treeOf(input.profile);
    const held = nodes.find((node) => node.id === input.id);
    if (held === undefined) {
        return {};
    }
    const edited: BookmarkNode = { ...held, title: input.title ?? held.title };
    if (held.kind === `url` && input.url !== undefined) {
        edited.url = input.url;
    }
    const kept = nodes.map((node) => (node.id === input.id ? edited : node));
    trees.set(input.profile, input.parent === undefined ? kept : placed(kept, edited, input.parent, undefined));
    return { node: edited };
};

export const demoMoveBookmark = (input: BookmarkMove): BookmarkChanged => {
    const nodes = treeOf(input.profile);
    const held = nodes.find((node) => node.id === input.id);
    if (held === undefined || held.parent === undefined) {
        return {};
    }
    trees.set(input.profile, placed(nodes, held, input.parent, input.index));
    return { node: { ...held, parent: input.parent } };
};

export const demoRemoveBookmark = (input: BookmarkRemove): BookmarkChanged => {
    const nodes = treeOf(input.profile);
    const gone = new Set([input.id]);
    for (const node of ordered(nodes)) {
        if (node.parent !== undefined && gone.has(node.parent)) {
            gone.add(node.id);
        }
    }
    trees.set(
        input.profile,
        nodes.filter((node) => !gone.has(node.id) || node.parent === undefined),
    );
    return {};
};
