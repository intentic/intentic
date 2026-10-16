import { campaignOf, optedOut, referringHost, sourceOf, taggedHref } from "./visit";

const APP = "https://app.intentic.dev";
const page = (address: string): URL => new URL(address);

describe("sourceOf", () => {
    it("keeps the campaign tags a visit landed with, over the site that sent it", () => {
        expect(sourceOf("?utm_source=hn&utm_campaign=launch&x=1", "https://news.ycombinator.com/item", "intentic.dev")).toEqual({
            utm_source: "hn",
            utm_campaign: "launch",
        });
    });

    it("names the other site as a referral when there are no tags, and nothing for this site or a direct visit", () => {
        expect(sourceOf("", "https://www.reddit.com/r/x", "intentic.dev")).toEqual({ utm_source: "www.reddit.com", utm_medium: "referral" });
        expect(sourceOf("", "https://intentic.dev/pricing/", "intentic.dev")).toEqual({});
        expect(sourceOf("", "", "intentic.dev")).toEqual({});
    });

    it("bounds a tag's length and drops empty ones", () => {
        expect(campaignOf(`?utm_source=${"a".repeat(400)}&utm_medium=`).utm_source).toHaveLength(150);
        expect(campaignOf("?utm_medium=").utm_medium).toBeUndefined();
    });

    it("ignores a referrer it cannot read", () => {
        expect(referringHost("not a url", "intentic.dev")).toBeUndefined();
    });
});

describe("taggedHref", () => {
    it("tags an app link with this site and the page it left from when the visit has no outside source", () => {
        const next = taggedHref(`${APP}/setup`, page("https://intentic.dev/pricing/"), {}, APP);
        expect(next).toBe(`${APP}/setup?utm_source=intentic.dev&utm_medium=site&utm_content=%2Fpricing%2F`);
    });

    it("hands an outside source to the app, keeping its own content tag", () => {
        const source = { utm_source: "hn", utm_campaign: "launch", utm_content: "top" };
        expect(taggedHref(APP, page("https://intentic.dev/"), source, APP)).toBe(`${APP}/?utm_source=hn&utm_campaign=launch&utm_content=top`);
    });

    it("carries an outside source onto the site's own pages, and leaves them alone without one", () => {
        expect(taggedHref("/pricing/", page("https://intentic.dev/"), { utm_source: "hn" }, APP)).toBe("https://intentic.dev/pricing/?utm_source=hn");
        expect(taggedHref("/pricing/", page("https://intentic.dev/"), {}, APP)).toBeUndefined();
    });

    it("never touches another site, a file, or a tag the link already has", () => {
        expect(taggedHref("https://github.com/intentic/intentic", page("https://intentic.dev/"), { utm_source: "hn" }, APP)).toBeUndefined();
        expect(taggedHref("/llms.txt", page("https://intentic.dev/"), { utm_source: "hn" }, APP)).toBeUndefined();
        expect(taggedHref(`${APP}/?utm_source=docs`, page("https://intentic.dev/docs/"), { utm_source: "hn" }, APP)).toBeUndefined();
    });
});

describe("optedOut", () => {
    it("honours Global Privacy Control and Do Not Track", () => {
        expect(optedOut({ globalPrivacyControl: true })).toBe(true);
        expect(optedOut({ doNotTrack: "1" })).toBe(true);
        expect(optedOut({ doNotTrack: null })).toBe(false);
    });
});
