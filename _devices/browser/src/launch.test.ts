import { ACTIVE_PORT_FILE, ownsEndpoint, parseActivePort } from "./launch.js";

/* Only this package's own browser is ever driven. A DevTools endpoint that merely answers (a developer's own Chrome on
   9222, with every session they are signed into) is somebody else's; ours is the one whose port file, written by the
   browser into our own profile, names the target that answers on that port right now. */

const PATH = "/devtools/browser/4b0c7a4e-3c1f-4a9e-9d4f-6f8a2b1c9e10";

test("the port file is read as Chromium writes it: the port, then the browser's own target", () => {
    expect(ACTIVE_PORT_FILE).toBe("DevToolsActivePort");
    expect(parseActivePort(`41235\n${PATH}\n`)).toEqual({ port: 41_235, path: PATH });
    expect(parseActivePort(`41235\r\n${PATH}\r\n`)).toEqual({ port: 41_235, path: PATH });
});

test("a torn or foreign file names no endpoint", () => {
    expect(parseActivePort("")).toBeUndefined();
    expect(parseActivePort("41235\n")).toBeUndefined();
    expect(parseActivePort(`0\n${PATH}`)).toBeUndefined();
    expect(parseActivePort(`9222\n/devtools/page/1`)).toBeUndefined();
});

// The target's id is new with every start, so a file an earlier run left behind never matches the browser that took
// its port since, and nothing answering at all is nothing to drive.
test("an endpoint is ours only when it answers with the very target our profile's file names", () => {
    const file = { port: 9222, path: PATH };
    expect(ownsEndpoint(file, PATH)).toBe(true);
    expect(ownsEndpoint(file, "/devtools/browser/somebody-elses")).toBe(false);
    expect(ownsEndpoint(file, undefined)).toBe(false);
    expect(ownsEndpoint(undefined, PATH)).toBe(false);
});
