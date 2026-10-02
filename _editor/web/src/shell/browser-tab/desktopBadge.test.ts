import "@intentic/testing/dom";
import { badgeTooltip, linkImage } from "./desktopBadge";

// The tab's mark as the desktop app's icon takes it (desktop-app badge.rs): an image a link carries without escaping,
// and a tooltip saying what the mark means.

describe(`an image for the app's icon`, () => {
    it(`is the PNG's base64, URL-safe and unpadded`, () => {
        expect(linkImage(`data:image/png;base64,iVBOR+w/AA==`)).toBe(`iVBOR-w_AA`);
    });

    it(`is nothing for a drawing that did not come out as a PNG`, () => {
        expect(linkImage(undefined)).toBeUndefined();
        expect(linkImage(`data:image/svg+xml;charset=utf-8,%3Csvg%3E`)).toBeUndefined();
    });
});

describe(`the tray's tooltip`, () => {
    it(`counts what needs the reader, past what the drawing can`, () => {
        expect(badgeTooltip({ kind: `asks`, count: 1 })).toBe(`1 needs you`);
        expect(badgeTooltip({ kind: `asks`, count: 12 })).toBe(`12 need you`);
    });

    it(`says what each other mark means, and nothing without one`, () => {
        expect(badgeTooltip({ kind: `done` })).toBe(`A turn finished while you were away`);
        expect(badgeTooltip({ kind: `working` })).toBe(`Agents are working`);
        expect(badgeTooltip({ kind: `offline` })).toBe(`Your sandbox isn't answering`);
        expect(badgeTooltip(undefined)).toBeUndefined();
    });
});
