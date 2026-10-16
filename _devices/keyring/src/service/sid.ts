import type { Runner } from "../run.js";
import { SID_RE } from "./paths.js";

// This user's security identifier, which names hardened mode's files and task. From `whoami /user`, whose CSV output
// is the same in every language Windows speaks.
export const currentSid = async (runner: Runner): Promise<string> => {
    const answer = await runner({ command: "whoami", args: ["/user", "/fo", "csv", "/nh"], timeoutMs: 10_000 });
    const sid = /"(?<sid>S-1-[\d-]+)"/u.exec(answer.stdout)?.groups?.["sid"];
    if (sid === undefined || !SID_RE.test(sid)) {
        throw new Error("Windows did not say who this user is (`whoami /user`)");
    }
    return sid;
};
