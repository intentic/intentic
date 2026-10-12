# discord

The Discord connection: a bot-token card and skill for the agent, plus a gateway process that turns server messages and voice calls into automation events.

```mermaid
flowchart LR
    discord["Discord"] <-->|"discord.js"| gw(["discord gateway<br/>node dist/gateway.js"])
    gw -->|"POST /listeners/discord/dispatch"| daemon["Daemon<br/>automations"]
    daemon -->|"/deliver"| gw
    cli["discord-voice CLI"] -->|"loopback"| gw
    gw -->|"POST /speech/transcribe<br/>per utterance"| daemon
    gw -->|"POST /speech/say<br/>per answer"| daemon
    agent["Agent"] -->|"REST via skill"| discord
```

- The card is a `cli` capability: the bot token reaches the agent's environment, and [the skill](skills/discord/SKILL.md) teaches it the Discord REST API with `curl`, including generating the invite link for the owner's server.
- The gateway is an `autoStart` extension process the daemon supervises while a Discord card or listener automation wants it. It holds one discord.js client per bot token and posts each human message to the daemon's listener route. On a mention it streams the automation's reply back into the channel as live edits. The daemon itself holds no Discord connection.
- Everything the daemon sends into Discord outside a turn goes through the gateway's `/deliver`: a conversation's reply placed between turns, and an owner-approved post from the approvals queue. With no automation holding a client, delivery uses the bot token over REST rather than opening a socket, and answers with a link to the message it posted.
- Voice runs in the gateway so a call outlives any single turn. The agent joins and leaves with `discord-voice` (on its PATH via `contributes.bin`); each utterance is transcribed on this machine by the daemon's own speech engine (`POST /speech/transcribe`, the one the composer's microphone uses) and dispatched as `voice_utterance`, and the finished transcript lands under `.intentic/records/artifacts/voice/`.
- The agent answers in the call with `discord-voice say` (and cuts itself off with `discord-voice stop`). The gateway asks the daemon's voice for the text (`POST /speech/say`, which streams mono PCM in the voice the owner set for the text's language), upsamples it to Discord's 48 kHz stereo, encodes it to Opus with the same codec that decodes what the bot hears, and plays it into the call one utterance at a time. What the bot says is written into the transcript as its own lines and dispatches no `voice_utterance`, so an automation never answers itself.
- Only the manifest is in every image. The built gateway ships in the `messaging` image pack; on a core image the card says the runtime is not included.
- Reconcile, status and shutdown come from [connector-runtime](../../_shared/connector-runtime); this package is only what is Discord-specific.

## Key files

- [src/gateway.ts](src/gateway.ts) — the process entry: reconcile hooks, delivery, loopback voice routes.
- [src/listener.ts](src/listener.ts) — messages to listener events, and the live reply painter.
- [src/voice.ts](src/voice.ts) — the voice session: capture, transcribe, dispatch, speak, write the transcript.
- [src/audio.ts](src/audio.ts) — PCM resampling both ways, WAV framing, and the serialized transcription and speech queues.
- [src/cli.ts](src/cli.ts) — `discord-voice`, the agent's join, say, stop, leave and status command.
- [intentic-extension.json](intentic-extension.json) — the card, the listener events and the gateway process.

## Commands

```sh
pnpm --filter @intentic/ext-discord build   # tsc to dist/, which the process runs
pnpm --filter @intentic/ext-discord test
```
