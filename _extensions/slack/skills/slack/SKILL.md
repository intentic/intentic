---
name: slack
description: Read, post, react and search in the connected Slack workspace via the Slack Web API, and help the user finish app setup. Use when the user asks to send a Slack message, list channels or users, read a thread, react to a message, or connect/install the Slack app.
---

# Slack (connected)

Authenticated with a bot token in `$SLACK_BOT_TOKEN`. Talk to Slack's Web API with `curl`.
Base URL: `https://slack.com/api`, Auth header: `-H "Authorization: Bearer $SLACK_BOT_TOKEN"`.

Slack always answers HTTP 200; the real result is `.ok` in the body. Check it: `| jq '.ok, .error'` on
anything that looks wrong. IDs (`C…` channel, `U…` user, `T…` team) come from the list commands below; a
message is addressed by its channel plus its `ts`.

## Setup (do this when the app isn't installed yet)

Slack apps are created from a **manifest**. Give the user this one: it declares exactly the scopes and events
this integration needs: and walk them through the five steps on the capability card:

```yaml
display_information:
  name: intentic
  description: Your agent, in Slack.
features:
  bot_user:
    display_name: intentic
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - reaction_added
  interactivity:
    is_enabled: false
  socket_mode_enabled: true
```

Then: **Basic Information → App-Level Tokens → Generate** with the `connections:write` scope (that's the
`xapp-` token), **Install App → Install to Workspace** (that's the `xoxb-` token), and paste both onto the
Slack capability. Finally the user must invite the bot to each channel it should see: `/invite @intentic`.

Confirm it landed: `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test | jq '{ok, team, user, user_id}'`

## Common commands

- List channels the workspace has (add `types=public_channel,private_channel` for private ones the bot is in):
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.list?limit=200" | jq '.channels[] | {id, name, is_member}'`
- Read recent messages in a channel:
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.history?channel=<CHANNEL_ID>&limit=20" | jq '.messages[] | {ts, user, text}'`
- Read a thread (`<THREAD_TS>` is the parent message's `ts`):
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.replies?channel=<CHANNEL_ID>&ts=<THREAD_TS>&limit=50" | jq '.messages[] | {ts, user, text}'`
- Post a message (drop `thread_ts` to post at channel level):
  `curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json; charset=utf-8" -d '{"channel":"<CHANNEL_ID>","thread_ts":"<THREAD_TS>","text":"hello"}' https://slack.com/api/chat.postMessage`
- React to a message (a shortcode, no colons):
  `curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" -d '{"channel":"<CHANNEL_ID>","timestamp":"<TS>","name":"white_check_mark"}' https://slack.com/api/reactions.add`
- Resolve a user id to a name:
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/users.info?user=<USER_ID>" | jq '.user | {name, real_name, tz}'`
- DM a person (open the conversation first, then post to the returned channel id):
  `curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" -d '{"users":"<USER_ID>"}' https://slack.com/api/conversations.open | jq '.channel.id'`
- Link to a message (handy when reporting what you did):
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/chat.getPermalink?channel=<CHANNEL_ID>&message_ts=<TS>" | jq -r .permalink`

## Writing for Slack

Slack is **not** markdown: it is `mrkdwn`. `*bold*` (single asterisks), `_italic_`, `~strike~`, `` `code` ``,
```` ```block``` ````, `> quote`. Links are `<https://url|label>`, a person is `<@U123>`, a channel is
`<#C123>`. Headings, tables and `[label](url)` do not render. Keep replies short and thread them.

## Being mentioned

When someone @mentions the bot, the gateway wakes an agent conversation and **streams your reply into the
thread for you** — in that case just answer in plain text and do not post it yourself with curl. Use the
commands above to act *elsewhere*: react, post to a different channel, DM someone.

A channel is one continuing conversation: follow-up mentions in the same channel keep talking to the same
agent (with its memory of the thread) until it goes quiet for a couple of hours.

Notes: `not_in_channel` means the bot hasn't been invited — ask the user to `/invite @intentic` there.
`missing_scope` names the scope the app lacks; it needs a reinstall from the app dashboard to add one.
