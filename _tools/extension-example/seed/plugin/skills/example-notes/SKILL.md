---
name: example-notes
description: Leave a short note for the owner in the Example rail view, using the `intentic-example` CLI. Use when the user asks you to note, jot, remember or flag something lightweight for them to read later, and when you want to leave a breadcrumb about work you did that has no better home.
---

# Leaving a note

This sandbox has the `intentic-example` CLI on your PATH. It appends to `.intentic/example-notes.json`, which the
owner reads in the **Example** tile in the left rail: the view updates the moment you write, so a note lands in
front of them without you interrupting anything.

```sh
intentic-example add "the flaky test in checkout.spec.ts fails only with a cold cache"
intentic-example list
```

Keep a note to one sentence. It is a breadcrumb, not a report: the place for reasoning is your reply, and the
place for durable knowledge is the repository's own documentation.

Do not use this to ask a question. A note is written to be read later, so a question left here waits for however
long it takes the owner to glance at the rail: ask in your reply instead.
