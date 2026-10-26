import { childEnv } from "./child-env.js";

test("children use a small pool without changing the daemon or explicit child settings", () => {
    const daemon = process.env["UV_THREADPOOL_SIZE"];
    expect(childEnv()["UV_THREADPOOL_SIZE"]).toBe("4");
    expect(childEnv({ UV_THREADPOOL_SIZE: "8", CUSTOM: "yes" })).toEqual({ UV_THREADPOOL_SIZE: "8", CUSTOM: "yes" });
    expect(process.env["UV_THREADPOOL_SIZE"]).toBe(daemon);
});

test("an explicit restricted environment never inherits daemon variables", () => {
    expect(childEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin", UV_THREADPOOL_SIZE: "4" });
    expect(childEnv({})).toEqual({ UV_THREADPOOL_SIZE: "4" });
});
