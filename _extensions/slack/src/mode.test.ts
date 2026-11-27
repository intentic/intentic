import { isHostedSandbox, slackModeOf } from "./mode.js";

const APP_TOKEN = "xapp-1-A1-1-abc";
const SIGNING_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

test("a hosted sandbox takes Request URLs once the card holds the signing secret, even beside an app-level token", () => {
    expect(slackModeOf({ signingSecret: SIGNING_SECRET }, true)).toBe("http");
    expect(slackModeOf({ appToken: APP_TOKEN, signingSecret: SIGNING_SECRET }, true)).toBe("http");
});

test("a hosted sandbox's card set up before HTTP mode keeps Socket Mode until its signing secret is pasted", () => {
    expect(slackModeOf({ appToken: APP_TOKEN }, true)).toBe("socket");
    expect(slackModeOf({ appToken: APP_TOKEN, signingSecret: "" }, true)).toBe("socket");
});

test("any other sandbox keeps Socket Mode while it holds an app-level token, and takes Request URLs only without one", () => {
    expect(slackModeOf({ appToken: APP_TOKEN, signingSecret: SIGNING_SECRET }, false)).toBe("socket");
    expect(slackModeOf({ appToken: APP_TOKEN }, false)).toBe("socket");
    expect(slackModeOf({ signingSecret: SIGNING_SECRET }, false)).toBe("http");
});

test("a card holding neither gives Slack no way in, hosted or not", () => {
    expect(slackModeOf({}, true)).toBeUndefined();
    expect(slackModeOf({ appToken: "", signingSecret: "" }, false)).toBeUndefined();
});

test("a sandbox is hosted when the daemon's environment says it runs as the platform's machine", () => {
    expect(isHostedSandbox({ SANDBOX_VM: "1" })).toBe(true);
    expect(isHostedSandbox({ SANDBOX_VM: "" })).toBe(false);
    expect(isHostedSandbox({})).toBe(false);
});
