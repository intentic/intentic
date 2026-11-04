import type { IntenticApi } from "@intentic/extension-api";
import { legacySandbox, legacyTarget, page, type PageLink } from "@intentic/sandbox-contract/app-routes";
import { here, hereIn } from "../lib/routes/links";
import { navigation } from "../workbench/navigation/navigation";

// THE APP'S PAGES AS AN EXTENSION LINKS TO THEM (api.links, 2.41.0): the constructors of the editor's own table, and a
// link made by one opened in the frame and the sandbox the reader is in (links.ts `here`), as the editor's own links are.

// A page as an extension built against an older API names it: a path, before `api.links`.
const isPath = (to: PageLink | string): to is string => typeof to === `string`;

/**
 * Where an extension's link goes: its page in the reader's frame and sandbox. A path is read as an address from before
 * frames, of the sandbox it names (`?sandbox=`) or the one on screen, so an extension that still sends one lands where
 * it meant; a path that names no such page (a top page, an address already in a frame) goes as it is.
 */
export const addressOf = (to: PageLink | string): string => {
    if (!isPath(to)) {
        return here(to);
    }
    const legacy = legacyTarget(to);
    if (legacy === undefined) {
        return to;
    }
    const sandbox = legacySandbox(to);
    return sandbox === undefined ? here(legacy.link) : hereIn(sandbox, legacy.link);
};

/** `api.links`, `api.navigate` and `api.href`, the same for every extension. */
export const linksApi: Pick<IntenticApi, `links` | `navigate` | `href`> = {
    links: page,
    navigate: (to) => void navigation().push(addressOf(to)),
    // The address behind the same page, for views whose rows are links rather than buttons.
    href: (to) => navigation().resolve(addressOf(to)).href,
};
