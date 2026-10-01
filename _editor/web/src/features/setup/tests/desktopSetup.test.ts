import type { DesktopSetupReport } from "../../../app/environments/desktop";
import { CLAIM_PATIENCE_MS, setupUnderWay } from "../desktopSetup";

// "Set it up now" stayed pressable through a four-minute install in the app; a second press starts a second install.

const report = (state: DesktopSetupReport[`state`]): DesktopSetupReport => ({ state, percent: 12 });

describe(`an install under way`, () => {
    it(`is one the app reports running, or waiting on its reader`, () => {
        expect([report(`running`), report(`waiting`)].map((shown) => setupUnderWay({ report: shown, claimed: false, failed: false }))).toEqual([
            true,
            true,
        ]);
    });

    it(`is one a machine claimed, while nothing said it ended`, () => {
        expect(setupUnderWay({ report: undefined, claimed: true, failed: false })).toBe(true);
    });

    it(`is over once it failed or was stopped, so the retry the page asks for can be pressed`, () => {
        expect([
            setupUnderWay({ report: report(`failed`), claimed: true, failed: false }),
            setupUnderWay({ report: report(`stopped`), claimed: true, failed: false }),
            setupUnderWay({ report: report(`running`), claimed: true, failed: true }),
        ]).toEqual([false, false, false]);
    });

    // Putting the app's card away drops its report, and a reload drops everything this page heard: neither may lock the
    // button for good behind a claim whose run already ended.
    it(`is over once a run said it ended, though its card was put away, or once the claim is long past`, () => {
        expect(setupUnderWay({ report: undefined, claimed: true, failed: false, ended: true })).toBe(false);
        expect(setupUnderWay({ report: undefined, claimed: true, failed: false, claimedFor: CLAIM_PATIENCE_MS - 1 })).toBe(true);
        expect(setupUnderWay({ report: undefined, claimed: true, failed: false, claimedFor: CLAIM_PATIENCE_MS })).toBe(false);
        // A run the app reports running stays under way, however old the claim.
        expect(setupUnderWay({ report: report(`running`), claimed: true, failed: false, claimedFor: CLAIM_PATIENCE_MS * 2 })).toBe(true);
    });

    it(`has not begun before a press reached the app`, () => {
        expect(setupUnderWay({ report: undefined, claimed: false, failed: false })).toBe(false);
    });
});
