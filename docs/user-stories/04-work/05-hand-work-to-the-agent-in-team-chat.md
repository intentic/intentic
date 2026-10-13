# Hand the agent work from my team's chat

As someone on a team whose day happens in Discord or Slack, I want to mention the agent where we already talk and get the work done in that same place, so that asking it is as cheap as asking a colleague and everyone can see what it is doing.

I write `@intentic the login redirect loops on Safari, can you fix it?` in a channel. Within a second my message shows it was heard, and a thread opens under it, named after what I asked. The thread is the whole job: a status card at the top says what the agent is doing right now, ticks off its checklist and counts the time, with a Stop button and a link to the conversation in Intentic. The answer arrives below as ordinary messages, code blocks intact. A teammate can reply in the thread while it works, without mentioning it, and the agent takes that into the same piece of work. When it is done my message carries a check; if it failed, a cross and the reason; if it needed the owner's approval first, a raised hand and a card saying so. Coming back to the thread days later picks the same conversation up where it stopped.

Setting it up is three things: paste the bot token, invite the bot with the link the agent gives, and switch on the Team assistant automation.

Slack works the same way. The answer goes into the mentioned message's own thread, since a Slack thread needs no opening and has no name. Slack's own "is working on it…" line shows under the thread while the agent works, and the answer is written in Markdown that Slack renders as written, tables included. Setting it up is pasting the app's two tokens (the agent writes the app manifest), inviting the app to a channel, and switching on the Team assistant on Slack automation. The app says hello when it is invited somewhere.

## Acceptance criteria

- [ ] A mention of the bot in a channel opens a thread from that message, named after it, and the answer is posted in the thread rather than in the channel
- [ ] The mentioned message shows it was heard within a few seconds, and ends marked done, failed, stopped or waiting for approval
- [ ] A message no automation answers leaves no thread and no lasting mark
- [ ] Work that takes more than a moment shows a status card that updates as the agent works: its current step, its checklist, the elapsed time
- [ ] The status card offers Stop and a link that opens the conversation in Intentic; once the work ends, the card shrinks to one line and keeps the link
- [ ] A quick answer posts no status card, only the answer
- [ ] Code blocks in a long answer are never cut into unbalanced halves, and tables are readable
- [ ] Messages in the thread reach the agent without a mention; one sent while it works is taken into the running work
- [ ] Two requests in one channel are two conversations, worked on at the same time up to the sandbox's limit on threads at once (3 unless the owner changes it); a request beyond that limit says it is queued until it starts
- [ ] Stop works only for people the automation answers without the owner's approval, and the card says who stopped it
- [ ] A request held for the owner's approval says so in its thread, and its answer arrives in the same thread once approved
- [ ] Replying in a thread days later continues the same conversation, with the work it already did
- [ ] The Discord card names the one privileged intent it needs, the invite link carries the thread and reaction permissions, and a Team assistant automation can be set up from Automations without writing a prompt
- [ ] In Slack, every criterion above holds the same way, with the answer in the mentioned message's thread; the app's manifest switches on the interactivity Stop needs, and a Team assistant on Slack automation can be set up from Automations without writing a prompt
