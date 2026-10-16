import { inAppPath, sameOriginPath } from "./inAppPath";

const ORIGIN = `https://app.example`;

describe(`an in-app path`, () => {
    it(`keeps a rooted path with its query and hash`, () => {
        expect(inAppPath(`/?sandbox=sbx&conversation=a1`, ORIGIN)).toBe(`/?sandbox=sbx&conversation=a1`);
        expect(inAppPath(`/agents/picked#changes`, ORIGIN)).toBe(`/agents/picked#changes`);
    });

    it(`refuses what a browser would resolve to another host`, () => {
        for (const target of [`//evil.example`, `/\\evil.example`, `/\\/evil.example`, `/\t/evil.example`]) {
            expect(inAppPath(target, ORIGIN)).toBeUndefined();
        }
    });

    it(`refuses absolute URLs, even on this origin, and relative paths`, () => {
        for (const target of [`https://evil.example/`, `${ORIGIN}/agents`, `javascript:alert(1)`, `agents`, ``]) {
            expect(inAppPath(target, ORIGIN)).toBeUndefined();
        }
    });

    it(`reads an already-resolved URL by its origin`, () => {
        expect(sameOriginPath(new URL(`${ORIGIN}/agents?x=1`), ORIGIN)).toBe(`/agents?x=1`);
        expect(sameOriginPath(new URL(`https://evil.example/agents`), ORIGIN)).toBeUndefined();
    });
});
