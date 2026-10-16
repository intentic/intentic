import type { Runner } from "../run.js";
import { androidTypist } from "./android.js";
import { linuxTypist } from "./linux.js";
import { macTypist } from "./mac.js";
import { noTypist, type Typist, typistFor } from "./typist.js";
import { windowsTypist } from "./windows.js";

export { androidTypist, adbPath, focusedNode, foregroundPackage, inputTextCommand } from "./android.js";
export { linuxSession, linuxTypist } from "./linux.js";
export { keystrokeScript, macTypist } from "./mac.js";
export { noTypist, type Inspected, type Place, type Seen, type Typed, type Typist, typistFor } from "./typist.js";
export { windowsTypist } from "./windows.js";

// This computer's typist: its own desktop's, and adb's for an attached phone.
export const platformTypist = (runner: Runner, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Typist => {
    const desktop =
        platform === "win32"
            ? windowsTypist(runner)
            : platform === "darwin"
              ? macTypist(runner)
              : platform === "linux"
                ? linuxTypist(runner, env)
                : noTypist(`The keyring cannot type on ${platform}.`);
    return typistFor(desktop, androidTypist(runner));
};
