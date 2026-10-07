import type { CapabilityCtx } from "../capability.js";
import { checkoutInto, withCheckoutLock } from "../git-checkout.js";

// A ctx that records every step checkoutInto takes, with the clone taking a moment, as a real one does: the window two
// callers would interleave in.
const recordingCtx = (): {
    readonly ctx: CapabilityCtx;
    readonly steps: string[];
    readonly envs: (Readonly<Record<string, string>> | undefined)[];
} => {
    const steps: string[] = [];
    const envs: (Readonly<Record<string, string>> | undefined)[] = [];
    const ctx = {
        files: {
            mkdir: async () => undefined,
            remove: async (path: string) => void steps.push(`remove ${path}`),
            move: async (from: string, to: string) => void steps.push(`move ${from} -> ${to}`),
        },
        terminalRun: {
            run: async (_session: string, command: string, options: { readonly env?: Readonly<Record<string, string>> }) => {
                steps.push(`run ${command}`);
                envs.push(options.env);
                await new Promise((resolve) => setTimeout(resolve, 20));
                return "";
            },
        },
    } as unknown as CapabilityCtx;
    return { ctx, steps, envs };
};

test("two checkouts of one extension run one after the other, never cloning over each other's staging dir", async () => {
    const { ctx, steps } = recordingCtx();
    await Promise.all([
        checkoutInto(ctx, "job", "/x", "demo", { url: "https://example.com/first.git" }),
        checkoutInto(ctx, "job", "/x", "demo", { url: "https://example.com/second.git" }),
    ]);
    const once = [
        "remove /x/.demo.cloning",
        "run git clone https://example.com/first.git .demo.cloning",
        "remove /x/demo",
        "move /x/.demo.cloning -> /x/demo",
    ];
    expect(steps).toEqual([...once, ...once.map((step) => step.replace("first", "second"))]);
});

test("a removal holding the checkout's lock makes a clone wait for it", async () => {
    const { ctx, steps } = recordingCtx();
    let release = (): void => undefined;
    const held = withCheckoutLock("/x", "demo", async () => {
        steps.push("removal starts");
        await new Promise<void>((resolve) => {
            release = resolve;
        });
        steps.push("removal ends");
    });
    const clone = checkoutInto(ctx, "job", "/x", "demo", { url: "https://example.com/demo.git" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(steps).toEqual(["removal starts"]);
    release();
    await Promise.all([held, clone]);
    expect(steps.slice(0, 3)).toEqual(["removal starts", "removal ends", "remove /x/.demo.cloning"]);
});

test("a token reaches the clone through its environment, never its command line", async () => {
    const { ctx, steps, envs } = recordingCtx();
    await checkoutInto(ctx, "job", "/x", "demo", { url: "https://example.com/demo.git", token: "ghp_secret" });
    expect(steps.join("\n")).not.toContain("ghp_secret");
    expect(envs[0]).toEqual({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}`,
    });
});
