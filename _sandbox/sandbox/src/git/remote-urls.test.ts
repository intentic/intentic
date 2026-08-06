import { expect, test } from "vitest";
import { parseRemote } from "./remote-urls.js";

test("parseRemote covers the three remote forms git writes", () => {
    expect(parseRemote("https://github.com/acme/web.git")).toEqual({ host: "github.com", project: "acme/web" });
    expect(parseRemote("https://gitlab.example.com/group/sub/app")).toEqual({ host: "gitlab.example.com", project: "group/sub/app" });
    expect(parseRemote("git@github.com:acme/web.git")).toEqual({ host: "github.com", project: "acme/web" });
    expect(parseRemote("ssh://git@gitlab.example.com:2222/group/app.git")).toEqual({ host: "gitlab.example.com", project: "group/app" });
    expect(parseRemote("https://user@github.com/Acme/Web")).toEqual({ host: "github.com", project: "Acme/Web" });
});

test("parseRemote refuses what nothing can stand behind", () => {
    expect(parseRemote("/home/user/repos/web")).toBeUndefined();
    expect(parseRemote("file:///home/user/repos/web")).toBeUndefined();
    expect(parseRemote("")).toBeUndefined();
});
