# Composer quick pick

The chat composer's `@` token reaches the four turn settings (persona, where it runs, model, effort) as well as
files. One key, no `#`; a picked setting leaves no text behind.

## One key

`@path` is the wire form of a mentioned file, not a composer convenience: the daemon extracts it
(`sandbox-contract/text/mentions.ts`), the transcript fold hides a chip for it, prompt complexity counts it, persona
routing reads it, plan feedback writes it. Giving files a different keystroke leaves two bad options: the composer
types `#`, the text says `@path`, and a character changes under the user's fingers; or the text changes too, and the
daemon and every old transcript change with it.

`#` also occurs in prose: `fix #123`, `C#`, a heading. Each would raise a picker mid-sentence, and Enter would then
pick instead of send.

The four settings are a handful of rows each. They do not need a key apiece; they need to be reachable from the one
key that already opens a list. `@intentic` sets the persona, `@sonnet` the model, `@high` the effort, `@omen` the
runner. An empty `@` lists each setting with its current value; Enter on one drills in (`@model:`), and the drill is
the token text itself, so Backspace walks out and nothing is remembered between keystrokes.

## A mention is a guess, a chip is a choice

Reading `@path` out of free text means reading it out of pasted text too, and terminal output is full of the shape:
`curl --data-binary @/tmp/req.json`, a `ps` dump quoting that command, a `pnpm list` line. So the two travel in
separate wire fields. `attachments` is what the user staged — an unresolvable one refuses the turn at the door
(BAD_REQUEST), leaving the words in the composer to fix. `mentions` is what the tokenizer read — one that escapes the
workspace or names no file is dropped, and the turn runs. The tokenizer refuses absolute, home, drive-letter and
climbing tokens outright, since no mention can be one.

## A picked setting leaves the text

A setting is a property of the turn. Its display is the pill row, which already shows it. Leaving `@intentic` inline
would spend tokens on words the model has to interpret, show one fact in two places, and create two states that can
disagree: delete the word and the persona has not changed; change the pill and the word is wrong.

What the user sees instead: the token vanishes, and the pill that now holds the value pulses once (`.composer-flash`).
The summary rows carry the verb (`Acts as`, `Where this runs`) so a pick reads as *set*, not *insert*.

## What is offered

Exactly what the pill row offers, control for control (`ChatPane.quickSources`): persona is withheld on a remote
conversation and under a workflow badge; model and effort under a workflow badge; placement once there is nowhere else
to go or the conversation is registered; files on a remote conversation. Offline runners and unanswered boxes are
left out rather than disabled, since a keyboard list has no use for a row that refuses the pick.
