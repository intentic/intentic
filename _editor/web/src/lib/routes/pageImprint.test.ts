import { pageImprint } from "./pageImprint";

describe(`pageImprint`, () => {
    test(`a page without parts is remembered by its path`, () => {
        expect(pageImprint({ path: `/sandbox/agent`, query: {} })).toBe(`/sandbox/agent`);
    });

    test(`each part of a page is remembered apart`, () => {
        expect(pageImprint({ path: `/sandbox/agent`, query: { section: `instructions` } })).toBe(`/sandbox/agent?section=instructions`);
        expect(pageImprint({ path: `/sandbox/agent`, query: { section: `tools` } })).not.toBe(
            pageImprint({ path: `/sandbox/agent`, query: { section: `instructions` } }),
        );
    });

    test(`the rest of the query does not name a new look`, () => {
        expect(pageImprint({ path: `/sandbox/models`, query: { provider: `openai` } })).toBe(`/sandbox/models`);
        expect(pageImprint({ path: `/sandbox/agent`, query: { section: `` } })).toBe(`/sandbox/agent`);
        expect(pageImprint({ path: `/sandbox/agent`, query: { section: [`a`, `b`] } })).toBe(`/sandbox/agent`);
    });
});
