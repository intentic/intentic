import { lastLentToRunner, lentToRunner, openRunnerTurn, runnerHoldsOf } from "./account-holds.js";

const released: string[] = [];
const hold = (account: string) => () => {
    released.push(account);
};

/* A Claude account lent to a runner is held here while a turn dispatched there is open (2026-11-11, omen-runner). */

test("an account lent while a turn is open is held until the runner's last open turn closes", () => {
    const closeFirst = openRunnerTurn("r1");
    const closeSecond = openRunnerTurn("r1");
    lentToRunner("r1", "acct", "t1", hold);
    lentToRunner("r1", "acct", "t2", hold);
    expect(runnerHoldsOf("r1")).toEqual({ open: 2, held: ["acct"] });
    expect(lastLentToRunner("r1", "acct")).toBe("t2");
    closeFirst();
    closeFirst();
    expect(runnerHoldsOf("r1")).toEqual({ open: 1, held: ["acct"] });
    expect(released).toEqual([]);
    closeSecond();
    expect(runnerHoldsOf("r1")).toEqual({ open: 0, held: [] });
    expect(released).toEqual(["acct"]);
});

test("an account lent with no turn open (a helper job) is not held, though its token is remembered", () => {
    lentToRunner("r2", "acct", "t1", hold);
    expect(runnerHoldsOf("r2")).toEqual({ open: 0, held: [] });
    expect(lastLentToRunner("r2", "acct")).toBe("t1");
});
