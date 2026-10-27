import { composeOfferOf } from "./composeOffer";

jest.mock(`../../../../models/sandbox/useSandboxVersion`, () => ({ useSandboxVersion: () => ({}) }));

const own = { hosted: false, serverManaged: false, composeManaged: false, slug: `demo` };

it(`offers Compose's update as known where the sandbox says Compose runs it`, () => {
    expect(composeOfferOf({ ...own, composeManaged: true })).toBe(`known`);
});

it(`offers it as likely on a sandbox of the owner's own with no container name, and not at all where ic swaps it`, () => {
    expect(composeOfferOf({ ...own, slug: undefined })).toBe(`likely`);
    expect(composeOfferOf(own)).toBeUndefined();
});

it(`never offers it where the platform or a deploy moves the sandbox`, () => {
    expect(composeOfferOf({ ...own, hosted: true, slug: undefined })).toBeUndefined();
    expect(composeOfferOf({ ...own, serverManaged: true, composeManaged: true })).toBeUndefined();
});
