import { isGitCorruption, onGitCorruption, reportGitFailure } from "./durability.js";

// The stderr a land died on after the 10-30 crash, as git 2.47 printed it.
const INFLATE = `error: inflate: data stream error (unknown compression method)
error: unable to unpack ff5612cb43c508638c7df39020e8c19accb3d8f9 header
fatal: loose object ff5612cb43c508638c7df39020e8c19accb3d8f9 (stored in /history/gits/root/objects/ff/5612cb43c508638c7df39020e8c19accb3d8f9) is corrupt`;

afterEach(() => onGitCorruption(undefined));

test("damaged storage reads as corruption, and a checkout missing history does not", () => {
    expect(isGitCorruption(INFLATE)).toBe(true);
    expect(isGitCorruption("error: object file .git/objects/45/b983be36b73c0788dc9cbcb76cbb80fc7bb057 is empty")).toBe(true);
    expect(isGitCorruption("fatal: index file corrupt")).toBe(true);
    expect(isGitCorruption("fatal: bad object 3e03077")).toBe(false);
    expect(isGitCorruption("fatal: ambiguous argument 'x': unknown revision or path not in the working tree.")).toBe(false);
    expect(isGitCorruption("error: corrupt patch at line 7")).toBe(false);
});

test("a failed git is told to the listener only when its storage is damaged, and a throwing listener stays quiet", () => {
    const heard: string[] = [];
    onGitCorruption((dir) => {
        heard.push(dir);
        throw new Error("listener broke");
    });

    reportGitFailure("/srv/game", "fatal: bad object 3e03077");
    reportGitFailure("/srv/game", undefined);
    reportGitFailure("/srv/game", INFLATE);

    expect(heard).toEqual(["/srv/game"]);
});
