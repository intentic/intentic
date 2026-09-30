import { reviewBadgeFor } from "./mobileTabs";

const changes = { count: 30, tooltip: `30 to review` };

it(`counts only what waits on a person when Review opens Needs you`, () => {
    // Uncommitted files are not on that page, so a land must not raise the number it shows.
    expect(reviewBadgeFor({ to: `/needs`, badge: { count: 2 } }, changes)).toEqual({ count: 2 });
    expect(reviewBadgeFor({ to: `/needs`, badge: undefined }, changes)).toBeUndefined();
});

it(`says what the Changes panel says when Review falls back to it`, () => {
    expect(reviewBadgeFor(undefined, changes)).toEqual(changes);
    expect(reviewBadgeFor(undefined, undefined)).toBeUndefined();
});
