import { stopAnswer } from "./card-stops.routes.js";

/* What a person's stop on a card answers (2026-11-23): stopped when this sandbox or the conversation's runner stopped
   something, else nothing stopped with the reason, never an error, so a caller stopping several things goes on. */

test("a stop here or on the runner answers stopped, whatever the other side said", () => {
    expect(stopAnswer(true, { stopped: false, reason: "The runner is offline." }, "none")).toEqual({ stopped: true });
    expect(stopAnswer(false, { stopped: true }, "none")).toEqual({ stopped: true });
});

test("a stop that stopped nothing says why: the runner's reason first, else what was asked had already ended", () => {
    expect(stopAnswer(false, { stopped: false, reason: "The runner is offline." }, "that job has already ended")).toEqual({
        stopped: false,
        stopReason: "The runner is offline.",
    });
    expect(stopAnswer(false, { stopped: false }, "that job has already ended")).toEqual({ stopped: false, stopReason: "that job has already ended" });
});
