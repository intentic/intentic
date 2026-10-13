---
name: discord
description: Read, post, and react in the connected Discord server via the Discord REST API, and help the user invite the bot / finish setup. Use when the user asks to send a Discord message, list channels/servers, read or react to messages, or connect/invite the bot.
---

# Discord (connected)

Authenticated with a bot token in `$DISCORD_BOT_TOKEN`. Talk to Discord's REST API with `curl`.
Base URL: `$DISCORD_API_URL/v10` (it stands in for https://discord.com/api/v10), Auth header: `-H "Authorization: Bot $DISCORD_BOT_TOKEN"`.

## Setup & invite (do this when the bot isn't in the user's server yet)
Discord only lets a server admin add a bot via an OAuth consent link: generate that link for them:
1. Confirm the token works and get the bot user:
   `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "$DISCORD_API_URL/v10/users/@me" | jq '{id, username}'`
2. Get the application id (needed for the invite URL):
   `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "$DISCORD_API_URL/v10/oauth2/applications/@me" | jq '{id, name}'`
3. Give the user this invite link (they open it, pick their server, approve):
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=309240908864`
   Permissions 309240908864 = View Channels + Send Messages + Read Message History + Add Reactions + Embed Links +
   Attach Files + Create Public Threads + Send Messages in Threads + Connect + Speak (answer in a thread of its own with a
   status card, react, and join voice channels to transcribe and answer aloud).
4. Tell them: in the Developer Portal → your app → Bot, enable the **Message Content** privileged intent
   (required to read message text; it can't be toggled via the API). Reading needs it; posting does not.
Then confirm it landed: `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "$DISCORD_API_URL/v10/users/@me/guilds" | jq '.[] | {id, name}'`
5. For the team to hand the bot work by mentioning it, the owner switches on the **Team assistant on Discord**
   automation (Automations, under the suggestions): a mention opens a thread where the agent works and answers.

## Threads
When an automation answers a message addressed to the bot (a mention, a reply, a DM, or anything in a thread it works
in), the gateway posts your reply into that message's thread for you: write your answer, never post it with curl as
well. The event's `thread` field is the thread's id, and a Discord thread is a channel, so anything else you post there
(a file, a reaction, a second message for later) goes to `/channels/<THREAD_ID>/...` like any channel. Messages in that
thread continue the same conversation: there is no need to ask people to mention you again.

## Common commands
- List the bot's servers:
  `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "$DISCORD_API_URL/v10/users/@me/guilds" | jq '.[] | {id, name}'`
- List channels in a server:
  `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "$DISCORD_API_URL/v10/guilds/<GUILD_ID>/channels" | jq '.[] | {id, name, type}'`
- Read recent messages:
  `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "$DISCORD_API_URL/v10/channels/<CHANNEL_ID>/messages?limit=20" | jq '.[] | {id, author: .author.username, content}'`
- React to a message (URL-encode the emoji; unicode 👍 = %F0%9F%91%8D):
  `curl -s -X PUT -H "Authorization: Bot $DISCORD_BOT_TOKEN" "$DISCORD_API_URL/v10/channels/<CHANNEL_ID>/messages/<MESSAGE_ID>/reactions/%F0%9F%91%8D/@me"`
- Send a message:
  `curl -s -X POST -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" -d '{"content":"hello"}' "$DISCORD_API_URL/v10/channels/<CHANNEL_ID>/messages"`

## Voice (listen, transcribe & answer aloud)
Use the `discord-voice` command-line tool (on your PATH): not curl. It drives the long-lived gateway that holds
the call across turns:
- `discord-voice join <channelId>`: join a voice channel and transcribe the conversation per speaker (on this machine).
- `discord-voice say "<text>"`: say something to the people in the call, in this sandbox's voice. With `-` instead of
  the text it reads the text from stdin (`printf '%s' "$answer" | discord-voice say -`), which keeps quotes out of the
  shell's way. Utterances are said one at a time, in order; it answers once yours starts sounding, or with why it can't.
- `discord-voice stop`: cut what is being said now and drop whatever was still queued.
- `discord-voice leave`: leave now and finalize the transcript.
- `discord-voice status`, current session: channel, duration, participants, utterances, live transcript path.
The transcript under `.intentic/records/artifacts/voice/` updates live after every utterance: read it mid-call to follow
the conversation. Each transcribed utterance also fires a `voice_utterance` listener event (batched), and when
the call ends (everyone leaves, or `discord-voice leave`) a `voice_transcript` event fires with the finalized
transcript: those wakes are where you turn it into notes/action items. Voice channel ids come from the channel
list command (`type: 2` = voice).

**Answering people in a call.** When someone in the call talks to you (a `voice_utterance` that asks you something, by
name or by context), answer with `discord-voice say`, not a text message. A listener automation
reacting to `voice_utterance` events answers the same way. Keep spoken answers short, one to three sentences, in the
language they spoke, written the way you would say them: no markdown, code, lists, URLs or ids (they are read out
literally or skipped). Anything longer or exact (a link, a command, a table) goes to the channel as a text message,
and you say that you posted it. What you say lands in the transcript as the bot's own line and fires no
`voice_utterance` event, so you never answer yourself. Being heard takes Discord's Speak permission in the channel,
which servers give everyone by default; if `say` reports speaking and nobody hears it, ask the owner to allow Speak
for the bot's role there.

Transcription and speech run on this sandbox's own speech engine and need nothing installed. Transcription's language
is the card's "Voice language" setting; left empty, it is detected per utterance. Speech picks its voice from the
language of the text you give it and the owner's voice settings. The first call on a sandbox whose image does not
carry the speech models fetches them (a few hundred MB) before the first line appears or the first word is said.

Notes: IDs come from the list commands above. If a read returns empty content, the Message Content intent isn't enabled (see Setup step 4).
