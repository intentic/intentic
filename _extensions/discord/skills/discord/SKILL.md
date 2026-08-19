---
name: discord
description: Read, post, and react in the connected Discord server via the Discord REST API, and help the user invite the bot / finish setup. Use when the user asks to send a Discord message, list channels/servers, read or react to messages, or connect/invite the bot.
---

# Discord (connected)

Authenticated with a bot token in `$DISCORD_BOT_TOKEN`. Talk to Discord's REST API with `curl`.
Base URL: `https://discord.com/api/v10` — Auth header: `-H "Authorization: Bot $DISCORD_BOT_TOKEN"`.

## Setup & invite (do this when the bot isn't in the user's server yet)
Discord only lets a server admin add a bot via an OAuth consent link — generate that link for them:
1. Confirm the token works and get the bot user:
   `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me | jq '{id, username}'`
2. Get the application id (needed for the invite URL):
   `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/oauth2/applications/@me | jq '{id, name}'`
3. Give the user this invite link (they open it, pick their server, approve):
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=1117248`
   Permissions 1117248 = View Channels + Send Messages + Read Message History + Add Reactions + Connect
   (read/list/react/send + join voice channels to transcribe).
4. Tell them: in the Developer Portal → your app → Bot, enable the **Message Content** privileged intent
   (required to read message text; it can't be toggled via the API). Reading needs it; posting does not.
Then confirm it landed: `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me/guilds | jq '.[] | {id, name}'`

## Common commands
- List the bot's servers:
  `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me/guilds | jq '.[] | {id, name}'`
- List channels in a server:
  `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/guilds/<GUILD_ID>/channels | jq '.[] | {id, name, type}'`
- Read recent messages:
  `curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "https://discord.com/api/v10/channels/<CHANNEL_ID>/messages?limit=20" | jq '.[] | {id, author: .author.username, content}'`
- React to a message (URL-encode the emoji; unicode 👍 = %F0%9F%91%8D):
  `curl -s -X PUT -H "Authorization: Bot $DISCORD_BOT_TOKEN" "https://discord.com/api/v10/channels/<CHANNEL_ID>/messages/<MESSAGE_ID>/reactions/%F0%9F%91%8D/@me"`
- Send a message:
  `curl -s -X POST -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" -d '{"content":"hello"}' https://discord.com/api/v10/channels/<CHANNEL_ID>/messages`

## Voice (listen & transcribe)
Use the `discord-voice` command-line tool (on your PATH) — not curl. It drives the long-lived gateway that holds
the call across turns:
- `discord-voice join <channelId>` — join a voice channel and transcribe the conversation per speaker (local whisper).
- `discord-voice leave` — leave now and finalize the transcript.
- `discord-voice status` — current session: channel, duration, participants, utterances, live transcript path.
The transcript under `.intentic/records/artifacts/voice/` updates live after every utterance — read it mid-call to follow
the conversation. Each transcribed utterance also fires a `voice_utterance` listener event (batched), and when
the call ends (everyone leaves, or `discord-voice leave`) a `voice_transcript` event fires with the finalized
transcript — those wakes are where you turn it into notes/action items. Voice channel ids come from the channel
list command (`type: 2` = voice).

Voice needs whisper.cpp, which was added to this sandbox's environment automatically when Discord was
connected. If `discord-voice join` reports whisper-cli missing, the sandbox just hasn't been rebuilt yet — ask
the owner to run the rebuild command on the Sandbox page's Environment card. Don't propose an overlay for this
yourself.

Notes: IDs come from the list commands above. If a read returns empty content, the Message Content intent isn't enabled (see Setup step 4).
