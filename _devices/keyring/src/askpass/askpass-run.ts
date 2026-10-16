import { keyringPaths } from "../address.js";
import { askKeyring, KeyringUnavailable } from "../client.js";
import { basenameOf } from "../policy.js";

// intentic-askpass: what ssh, sudo and git run when they need a password (SSH_ASKPASS, SUDO_ASKPASS, GIT_ASKPASS). The
// prompt they pass is sent to the keyring, which asks the person and answers; the value goes to standard output, for
// the program that asked, and nowhere else. A refusal prints nothing there, so the program sees an empty answer fail
// rather than a sentence it would try as a password.

interface Writable {
    readonly write: (text: string) => void;
}

// Who is asking, in words, when the platform says cheaply: the parent's executable name, for the person's prompt.
const parentName = (): string | undefined => {
    const name = process.env["SUDO_COMMAND"] === undefined ? undefined : "sudo";
    return name ?? (process.env["GIT_ASKPASS"] !== undefined && process.env["GIT_EXEC_PATH"] !== undefined ? "git" : process.env["SSH_ASKPASS"] !== undefined ? "ssh" : undefined);
};

export const askpass = async (prompt: string, stdout: Writable, stderr: Writable): Promise<number> => {
    try {
        const parent = parentName();
        const answer = await askKeyring({ address: keyringPaths().address }, parent === undefined ? { op: "askpass", prompt } : { op: "askpass", prompt, parent });
        if (answer.ok) {
            stdout.write(`${answer.value}\n`);
            return 0;
        }
        stderr.write(`intentic-askpass: ${answer.refusal}\n`);
        return 1;
    } catch (error) {
        stderr.write(`intentic-askpass: ${error instanceof KeyringUnavailable ? error.message : "the keyring could not be asked"}\n`);
        return 1;
    }
};

// Whether this process was started as intentic-askpass: the compiled keyring is hard-linked under that name. Either
// separator, since a Windows path reaches here as it was written.
export const startedAsAskpass = (argv0: string = process.execPath, argv1: string | undefined = process.argv[1]): boolean =>
    [argv0, argv1].some((path) => path !== undefined && basenameOf(path).toLowerCase().startsWith("intentic-askpass"));
