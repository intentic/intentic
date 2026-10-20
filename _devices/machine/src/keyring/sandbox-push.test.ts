import { linksToTell } from "./sandbox-push.js";

// Which sandboxes a Passwords change is pushed to: the one a request came from, matched by address however its trailing
// slash is written, or every link when a new or changed entry may serve any of them.

const link = (sandboxUrl: string, id: string) => ({ sandboxUrl, id });

const LINKS = [link("https://alpha.intentic.dev", "a"), link("https://beta.intentic.dev/", "b")];

test("a request's answer goes to the sandbox that asked, slash or not", () => {
    expect(linksToTell(LINKS, "https://beta.intentic.dev").map((held) => held.id)).toEqual(["b"]);
    expect(linksToTell(LINKS, "https://alpha.intentic.dev/").map((held) => held.id)).toEqual(["a"]);
});

test("a sandbox this computer has no link to is told nothing", () => {
    expect(linksToTell(LINKS, "https://gamma.intentic.dev")).toEqual([]);
});

test("an entry saved or changed is told to every link", () => {
    expect(linksToTell(LINKS, undefined).map((held) => held.id)).toEqual(["a", "b"]);
});
