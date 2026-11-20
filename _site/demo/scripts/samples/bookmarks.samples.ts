import type { GroupSamples } from "./context.ts";

// A bookmark added to an agents' browser profile the fixture keeps nothing for, moved, renamed and removed again, so the
// visitor's own tree is as it was.
export const bookmarksSamples: GroupSamples<`bookmarks`> = () => ({
    list: { profile: `_own` },
    add: { profile: `web`, kind: `url`, title: `Example`, url: `https://example.com/` },
    edit: { profile: `web`, id: `bk-new-1`, title: `Example Domain` },
    move: { profile: `web`, id: `bk-new-1`, parent: `other`, index: 0 },
    remove: { profile: `web`, id: `bk-new-1` },
});
