---
name: knowledge
description: The owner's personal knowledge base, a markdown folder that is also a typed graph of the people, projects, companies, decisions and terms around this work, driven by the `kb` CLI. Use it BEFORE answering anything about the owner, who they work with, what a project or an internal word means, or what was decided and why, and use it WITHOUT being asked to record a durable fact you have just learned about any of those. Not for facts about the code itself (that is what the repository and its documentation are for).
---

# The knowledge base

`kb` is on your PATH. It reads a folder of markdown notes: `knowledge/` in the workspace unless `$KB_FOLDER`
says otherwise: where every note is a **thing** and every link is a **connection between things**.

```sh
kb find "ada"                       # search names, header facts and prose
kb read "Ada Lovelace"              # the note, its facts, and its links both ways
kb list --type decision             # everything of one kind
kb find --linked-to Intentic        # everything connected to one thing
kb links "Ada Lovelace"             # just the connections
kb graph Intentic --depth 2         # the neighbourhood, as a map
kb check                            # broken links, orphans, vocabulary drift
kb vocab                            # the kinds and relationships this knowledge base has adopted
```

Add `--json` to any of them. Exit 0 found something, 1 found nothing, 2 could not run.

## When to read it

**Before answering a question about the owner's world.** Who someone is, what a project is, what an internal
word means, what was decided about something and why, how two things relate. One `kb find` costs a second and
is the difference between an answer grounded in what this owner actually told you and a plausible invention.

Start with `kb find <the words in the question>`. If it lands on a note, `kb read` it and follow the links that
matter: the connections are the point, and the neighbouring note is usually where the answer actually is.

**Not for questions about the code.** How a package is put together, where a function lives, what a file does:
that is `iq` and the repository's own documentation. The knowledge base is for the things around the code that no file
records: people, decisions, agreements, vocabulary, context.

## When to write to it

Without being asked, when you learn something **durable** about the owner's world that nothing else records:

- a person and their role, what they work on, how they prefer to be dealt with;
- a project or a company and what it is for;
- a decision and its reason: especially one whose reason will be invisible in six months;
- an internal word that means something specific here;
- a fact that corrects something the knowledge base currently says.

Do **not** write: anything about the current task's mechanics, anything already in a README, anything you are
guessing at, anything the owner asked you to keep out. A note that is wrong is worse than no note, because
everything downstream will believe it.

```sh
kb new "Ada Lovelace" --type person --tag colleague \
  --link works_on=Intentic --body "Prefers short PRs. Reviews on Tuesdays."

kb link "Ada Lovelace" knows "Charles Babbage"     # connect two notes
kb set "Ada Lovelace" employer "Analytical Engines Ltd"   # a plain fact
```

`kb new` puts a note at `<type>/<slug>.md` and writes the header for you. You may also write the file yourself
with your ordinary file tools: the knowledge base is plain markdown and nothing here is a write API you must go
through. What matters is the shape below.

## The shape of a note

```markdown
---
type: person
aliases: [Ada]
tags: [colleague]
works_on: ["[[Intentic]]"]
knows: ["[[Charles Babbage]]"]
employer: Analytical Engines Ltd
---

Wrote the first program. Prefers short PRs, reviews on Tuesdays.
Disagreed with [[decisions/why-extensions]] at the time and came round.
```

Four rules, and they are the whole format:

1. **`type:` is what makes a note a thing** rather than a page. A note without one is invisible to every
   "show me every decision about X" question you will ever ask. Always set it.
2. **A link in a header field is a named relationship.** `works_on: ["[[Intentic]]"]` is an edge labelled
   `works_on`. The brackets are what the graph sees, a bare `works_on: Intentic` is a string that connects
   nothing, and it will look perfectly fine while doing so.
3. **A link in the prose is an ordinary connection**: use it freely, mid-sentence, wherever another note is
   mentioned. It costs nothing and it is what makes the knowledge base navigable later.
4. **The header holds facts you would look something up BY** (an employer, a city, a version); the prose holds
   everything you would want to read. Both are searched.

Links resolve by title, alias, filename or path, case-insensitively, so `[[Ada]]`, `[[ada-lovelace]]` and
`[[person/ada-lovelace]]` are the same note. A link to a note nobody has written yet is fine and deliberate:
`kb check` lists them as the knowledge base's to-do list.

## The vocabulary

`kb vocab` prints the kinds and relationships this knowledge base has agreed on, and the note behind it explains what
each one means. **Read it before inventing a word.** Reuse `works_on` rather than coining `contributes_to`;
reuse `person` rather than `human`. A knowledge base with four words for one relationship can no longer answer questions
by relationship, which is most of what it was for.

Nothing stops you using a new one when you genuinely meet something new: capture always succeeds, and the new
word shows up in `kb check` and in the owner's panel as something to adopt or rename. If you introduce one
deliberately, add it to the vocabulary note in the same turn and say what it means.

## Keeping it honest

Run `kb check` when you have written several notes. It reports links pointing at notes nobody wrote, notes
that fell out of the graph entirely, notes with no type, words the vocabulary has not adopted, and headers it
could not parse. None of it is an error: it is the list of things that would otherwise quietly rot.

**Correct rather than accumulate.** When you learn that something in the knowledge base is wrong, edit that note. A
second note saying the opposite makes both useless.
