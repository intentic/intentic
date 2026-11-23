import { stoppedOrSay } from "./stopOutcome";

const said = (reason: string): string => `Nothing was stopped: ${reason}`;

it("passes a stop that stopped something", () => {
    expect(() => stoppedOrSay({ stopped: true }, said)).not.toThrow();
});

it("says a stop that stopped nothing, with the daemon's reason", () => {
    expect(() => stoppedOrSay({ stopped: false, stopReason: `that job has already ended` }, said)).toThrow(`Nothing was stopped: that job has already ended`);
});
