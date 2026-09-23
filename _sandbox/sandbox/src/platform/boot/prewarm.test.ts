import { waitForStarter } from "./prewarm.js";

describe("waitForStarter", () => {
    it("answers as soon as the assigned starter port serves HTTP", async () => {
        const answers = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

        await expect(
            waitForStarter({ starterKey: "site--landing", processes: { portOf: () => 4321 }, answers }, { maxMs: 100, pollMs: 1 }),
        ).resolves.toBe("ready");
        expect(answers).toHaveBeenCalledTimes(2);
        expect(answers).toHaveBeenCalledWith(4321);
    });

    it("does not spend the readiness window when the starter was not launched", async () => {
        const answers = jest.fn();

        await expect(
            waitForStarter({ starterKey: "site--landing", processes: { portOf: () => undefined }, answers }, { maxMs: 100, pollMs: 1 }),
        ).resolves.toBe("not-running");
        expect(answers).not.toHaveBeenCalled();
    });
});
