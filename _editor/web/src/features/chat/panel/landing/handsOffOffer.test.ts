// Pins who is asked to let the sandbox run itself: only a maintainer reading plain words by their own choice on a
// sandbox that still runs hands-on, and never again once they said not now there.
import "@intentic/testing/dom";

const { offersHandsOff } = await import(`./handsOffOffer`);

const FITS = { canShip: true, mode: `hands-on`, override: `maker`, sandboxId: `sbx`, dismissed: [] } as const;

test(`asks a maintainer who chose plain words on a hands-on sandbox`, () => {
    expect(offersHandsOff(FITS)).toBe(true);
});

test(`never asks below maintainer, on a hands-off sandbox, without plain words chosen, or once put away`, () => {
    expect(offersHandsOff({ ...FITS, canShip: false })).toBe(false);
    expect(offersHandsOff({ ...FITS, mode: `hands-off` })).toBe(false);
    expect(offersHandsOff({ ...FITS, mode: undefined })).toBe(false);
    expect(offersHandsOff({ ...FITS, override: undefined })).toBe(false);
    expect(offersHandsOff({ ...FITS, override: `developer` })).toBe(false);
    expect(offersHandsOff({ ...FITS, dismissed: [`sbx`] })).toBe(false);
    expect(offersHandsOff({ ...FITS, sandboxId: undefined })).toBe(false);
});
