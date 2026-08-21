# @intentic/ext-discord

Discord as a place the agent works: it reads channels, replies, and can join a voice channel and speak.

## Responsibilities

- Hold a gateway connection and turn Discord events into agent turns.
- Declare the event labels, filters and starter prompt the generic automation editor renders.
- Give the agent the ability to post, react, and read history.
- Join voice, stream audio in and out.

## Key files

- [src/gateway.ts](src/gateway.ts): the connection, and staying on it.
- [src/listener.ts](src/listener.ts): which Discord events become a turn, and which are ignored.
- [src/voice.ts](src/voice.ts) / [src/audio.ts](src/audio.ts): joining voice, and the audio path in both directions.

## How it fits

This is a **daemon-side** extension, not a browser one: it contributes a listener, a process, a bin and
capabilities: no views. It runs inside the sandbox alongside the agent, and the browser never talks to Discord.

## Conventions & gotchas

- Not every message is a turn. `listener.ts` is where that judgement lives, and getting it wrong is the difference
  between an employee and a bot that replies to itself.
