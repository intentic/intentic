import { landFailureOf } from "../land-failure.js";

// What the land on 10-31 06:00 died on, as execFile reported it: the command line, then git's stderr whole.
const INFLATE = new Error(`Command failed: git --no-optional-locks -c core.fileMode=false -C /work diff --binary -M 3222b3e edac976
error: inflate: data stream error (unknown compression method)
error: unable to unpack ff5612cb43c508638c7df39020e8c19accb3d8f9 header
fatal: loose object ff5612cb43c508638c7df39020e8c19accb3d8f9 (stored in /history/gits/root/objects/ff/5612cb43c508638c7df39020e8c19accb3d8f9) is corrupt`);

test("a land that died on damaged git storage is kept as repository corruption, not as git's raw words alone", () => {
    expect(landFailureOf(INFLATE)).toEqual({ reason: INFLATE.message, code: "repo_corrupt" });
});

test("a checkout that lost its history is not mistaken for damaged storage", () => {
    expect(landFailureOf(new Error("Command failed: git diff\nfatal: bad object 3e03077"))).toEqual({ reason: "Command failed: git diff\nfatal: bad object 3e03077" });
});
