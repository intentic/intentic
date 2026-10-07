import { type RebuildFacts, rebuildRouteOf } from "./rebuildRoute";

// Every way a waiting recipe gets built, decided once, so the card always draws the control or the sentence for why not.
// The case that drew nothing: a container the installer did not start, under a banner saying "Rebuild needed".

const facts: RebuildFacts = { pending: true, arriving: false, hosted: false, owner: true, serverManaged: false, fromCheckout: false, slug: `demo` };

it(`builds a hosted sandbox on the platform for its owner, and says so to anyone else`, () => {
    expect(rebuildRouteOf({ ...facts, hosted: true })).toBe(`hosted`);
    expect(rebuildRouteOf({ ...facts, hosted: true, owner: false })).toBe(`owner-only`);
});

it(`takes the deploy command, the checkout and the device swap in the card's own order`, () => {
    expect(rebuildRouteOf({ ...facts, serverManaged: true, fromCheckout: true })).toBe(`server`);
    expect(rebuildRouteOf({ ...facts, fromCheckout: true })).toBe(`checkout`);
    expect(rebuildRouteOf(facts)).toBe(`device`);
});

it(`says there is no rebuild from here for a container nobody here started`, () => {
    expect(rebuildRouteOf({ ...facts, slug: undefined })).toBe(`elsewhere`);
});

it(`answers something arriving with a rebuild while nothing approved waits, and says nothing when nothing does`, () => {
    expect(rebuildRouteOf({ ...facts, pending: false, arriving: true })).toBe(`nothing-pending`);
    expect(rebuildRouteOf({ ...facts, pending: false })).toBe(undefined);
});
