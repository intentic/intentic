import { browserOwnsClick } from "@intentic/ui";
import { flashElement } from "@intentic/ui/motion";
import { afterPaint } from "../../lib/afterPaint";
import { type SideInput, sideTabId } from "./sideTabs";
import { claimLink, describeTab, revealSideView, sideViewOf } from "./sideViews";

// Links a side view recognises (a CI run's page, a server's localhost address) open beside the section instead of in a
// new browser tab: the conversation that mentioned the thing stays on screen while it is looked at. Anything unclaimed,
// and every modified click, is left to the browser as before.

/** What a claimed link opens: the side view, its input, and the words its tab would wear. */
export interface ClaimedLink {
    readonly view: string;
    readonly input: SideInput;
    readonly label: string;
}

// Rings what a claimed link opened, once it is drawn: a link whose tab was already in front changed nothing on screen,
// and one in an agent's reply was clicked twelve times running. The main area when it is what shows the thing (a lent
// tab, Browsers while the reader stands on /browsers), else the side panel. Asked of the document the press came
// from, since a popped-out chat draws its own side panel.
const pointAtClaimed = (view: string, doc: Document): void => {
    void afterPaint().then(() => {
        flashElement(doc.querySelector(sideViewOf(view)?.lent?.() === true ? `main` : `.side-tabs`));
    });
};

// Opens what a claim names where this window can show it (revealSideView). Answers whether anything opened, so a
// claimed link that can't be shown stays a link. `from` is the pressed element, for which window to point in.
export const openClaimed = (claimed: Pick<ClaimedLink, `view` | `input`>, from?: Element | null): boolean => {
    const opened = revealSideView(claimed.view, claimed.input);
    if (opened) {
        pointAtClaimed(claimed.view, from?.ownerDocument ?? document);
    }
    return opened;
};

// A link written into plain text, up to where prose would end it: whitespace, or a closing bracket or stop after it.
const LINK_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gu;
const TRAILING = /[).,;:!?\]]+$/u;

// The first link in plain text that a side view claims: an errand's prompt carries the page of the thing it is about (a
// ci-fix errand, its failing run), which a mark on the errand's line then opens beside the chat.
export const claimInText = (text: string): ClaimedLink | undefined => {
    for (const [found] of text.matchAll(LINK_IN_TEXT)) {
        const claimed = claimLink(found.replace(TRAILING, ``));
        if (claimed !== undefined) {
            // The tab's own title ("Run #4818"), in the reader's language, else the side view's family name.
            const tab = { id: sideTabId(claimed.view, claimed.input), ...claimed };
            return { ...claimed, label: describeTab(tab)?.title ?? sideViewOf(claimed.view)?.label ?? `` };
        }
    }
    return undefined;
};

// Delegated click handler for links rendered inside v-html (the chat's markdown), where anchors host no listener of
// their own. File mentions are openFileRef's.
export const openClaimedLinkFromEvent = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || browserOwnsClick(event)) {
        return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest<HTMLAnchorElement>(`a[href]`);
    if (link === null || link === undefined || link.classList.contains(`md-file-link`)) {
        return;
    }
    const claimed = claimLink(link.href);
    if (claimed === undefined) {
        return;
    }
    if (openClaimed(claimed, link)) {
        event.preventDefault();
    }
};
