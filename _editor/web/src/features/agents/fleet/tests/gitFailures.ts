// Land failures as the daemon hands them over: execFile's rejection message for a git that exited non-zero, which is
// the command line and then git's stderr whole, newlines and all. Captured, not written: git 2.47.3 run untranslated
// (LC_ALL=C) through Node 24's promisified execFile against a scratch repo, `error.message` kept verbatim. The web suite
// does not spawn git, so the shapes live here; recapture them the same way if git's wording is ever in doubt.

// `git diff` naming a commit the checkout's object store does not have.
export const BAD_OBJECT = `Command failed: git --no-optional-locks -C /tmp/gitcap/repo diff --output=/tmp/gitcap/out HEAD 3e030773e030773e030773e030773e030773e030\nfatal: bad object 3e030773e030773e030773e030773e030773e030\n`;

// `git apply --check` on a malformed patch: apply says `error:`, not `fatal:`.
export const CORRUPT_PATCH = `Command failed: git --no-optional-locks -C /tmp/gitcap/repo apply --check /tmp/gitcap/x.patch\nerror: corrupt patch at line 7\n`;

// A revision git cannot resolve: the verdict is followed by a hint, so git's last line is not its verdict.
export const UNKNOWN_REVISION = `Command failed: git --no-optional-locks -C /tmp/gitcap/repo diff c011c54 3e03077\nfatal: ambiguous argument 'c011c54': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n`;

// `git apply --check` on a patch file that is gone.
export const MISSING_PATCH = `Command failed: git --no-optional-locks -C /tmp/gitcap/repo apply --check /tmp/gitcap/missing.patch\nerror: can't open patch '/tmp/gitcap/missing.patch': No such file or directory\n`;

// `git apply --check` on a patch whose context the tree no longer has: two verdict lines, the last the one that sums up.
export const PATCH_CLASH = `Command failed: git --no-optional-locks -C /tmp/gitcap/repo apply --check /tmp/gitcap/clash.patch\nerror: patch failed: a.txt:1\nerror: a.txt: patch does not apply\n`;
