import { isReviewCommand, reviewCommandOf } from "./reviewCommands";

const listed = (...names: string[]) => names.map((name) => ({ name, description: `` }));

test(`each harness's reviewer is found by the name its list publishes, Claude Code's first`, () => {
    expect(reviewCommandOf(listed(`compact`, `code-review`, `security-review`))).toBe(`code-review`);
    expect(reviewCommandOf(listed(`init`, `review`))).toBe(`review`);
    expect(reviewCommandOf(listed(`review`, `code-review`))).toBe(`code-review`);
    expect(reviewCommandOf(listed(`release`))).toBeUndefined();
    expect(isReviewCommand({ name: `security-review`, description: `` })).toBe(false);
});
