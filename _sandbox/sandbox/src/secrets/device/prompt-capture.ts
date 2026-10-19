// A PASSWORD TYPED INTO A HIDDEN PROMPT. A program that wants a secret turns the terminal's echo off and prints its
// question without a newline (`Password for npm:`); what the person types after that, up to Enter, is the answer.
// netd watches the editor's terminals and edits that line as the tty does (its term/hidden.rs), then tells this daemon
// once (`ToNode::HiddenLine`). This file is the pure half here: which prompts are worth remembering (a one-time code is
// not) and the words a capture is named by. Where a capture goes is terminal-capture.ts. Nothing here logs.

const COMMAND_MAX = 200;

// What asks for a one-time code rather than a password: kept nowhere, since it is wrong a minute later.
const ONE_TIME =
    /\b(otp|2fa|mfa|totp|one[- ]?time|verification|verify|authenticator|security code|auth(?:entication)? code|passcode|pin|token code|code from|[0-9]-digit|six[- ]digit|yubikey|touch)\b/iu;
// What asks for a secret at all: the words programs use, in the languages a prompt is usually in.
const SECRET = /(pass(?:word|phrase)?|pwd|secret|passwort|contraseña|mot de passe|hasło|kennwort)\b/iu;

/** Whether a prompt asks for something worth remembering: a password or passphrase, never a one-time code. */
export const remembersPrompt = (prompt: string): boolean => prompt !== "" && SECRET.test(prompt) && !ONE_TIME.test(prompt);

// A shell's own prompt line before a command (`radar@box:~$ npm login`), down to the command.
const SHELL_PROMPT = /^.*?[$#%❯›»>]\s+/u;

/** The command a person ran, as its capture is titled: `npm login`, `sudo apt update` read as `sudo apt`. */
export const commandTitle = (commandLine: string | undefined): string | undefined => {
    const line = commandLine?.replace(SHELL_PROMPT, "").trim();
    if (line === undefined || line === "") {
        return undefined;
    }
    const words = line.split(/\s+/u).filter((word) => !word.startsWith("-") && !word.includes("="));
    return words.slice(0, 2).join(" ").slice(0, COMMAND_MAX) || undefined;
};

export const clampCommand = (commandLine: string | undefined): string | undefined => {
    const line = commandLine?.trim();
    return line === undefined || line === "" ? undefined : line.slice(0, COMMAND_MAX);
};
