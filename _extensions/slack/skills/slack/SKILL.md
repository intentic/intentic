---
name: slack
description: Read, post, react and search in the connected Slack workspace via the Slack Web API, and help the user finish app setup. Use when the user asks to send a Slack message, list channels or users, read a thread, react to a message, or connect/install the Slack app.
---

# Slack (connected)

Authenticated with a bot token in `$SLACK_BOT_TOKEN`. Talk to Slack's Web API with `curl`.
Base URL: `$SLACK_API_URL` (it stands in for https://slack.com/api), Auth header: `-H "Authorization: Bearer $SLACK_BOT_TOKEN"`.

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
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
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
      - member_joined_channel
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```

Then: **Basic Information → App-Level Tokens → Generate** with the `connections:write` scope (that's the
`xapp-` token), **Install App → Install to Workspace** (that's the `xoxb-` token), and paste both onto the
Slack capability. Finally the user must invite the bot to each channel it should see: `/invite @intentic`.
For the team to hand the app work by mentioning it, the owner switches on the **Team assistant on Slack**
automation (Automations, under the suggestions).

An app made from an older manifest lacks two things this one has: **Interactivity & Shortcuts** switched on
(without it, the Stop button on a status card shows an error) and the `member_joined_channel` event (the hello
when it is invited to a channel). Both are toggles on the app's dashboard; Socket Mode needs no request URL.

Confirm it landed: `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "$SLACK_API_URL/auth.test" | jq '{ok, team, user, user_id}'`

## Common commands

- List channels the workspace has (add `types=public_channel,private_channel` for private ones the bot is in):
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "$SLACK_API_URL/conversations.list?limit=200" | jq '.channels[] | {id, name, is_member}'`
- Read recent messages in a channel:
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "$SLACK_API_URL/conversations.history?channel=<CHANNEL_ID>&limit=20" | jq '.messages[] | {ts, user, text}'`
- Read a thread (`<THREAD_TS>` is the parent message's `ts`):
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "$SLACK_API_URL/conversations.replies?channel=<CHANNEL_ID>&ts=<THREAD_TS>&limit=50" | jq '.messages[] | {ts, user, text}'`
- Post a message (drop `thread_ts` to post at channel level):
  `curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json; charset=utf-8" -d '{"channel":"<CHANNEL_ID>","thread_ts":"<THREAD_TS>","text":"hello"}' "$SLACK_API_URL/chat.postMessage"`
- React to a message (a shortcode, no colons):
  `curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" -d '{"channel":"<CHANNEL_ID>","timestamp":"<TS>","name":"white_check_mark"}' "$SLACK_API_URL/reactions.add"`
- Resolve a user id to a name:
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "$SLACK_API_URL/users.info?user=<USER_ID>" | jq '.user | {name, real_name, tz}'`
- DM a person (open the conversation first, then post to the returned channel id):
  `curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" -d '{"users":"<USER_ID>"}' "$SLACK_API_URL/conversations.open" | jq '.channel.id'`
- Link to a message (handy when reporting what you did):
  `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "$SLACK_API_URL/chat.getPermalink?channel=<CHANNEL_ID>&message_ts=<TS>" | jq -r .permalink`

## Writing for Slack

What you post with curl's `text` is **not** markdown: it is `mrkdwn`. `*bold*` (single asterisks), `_italic_`,
`~strike~`, `` `code` ``, ```` ```block``` ````, `> quote`. Links are `<https://url|label>`, a person is `<@U123>`, a
channel is `<#C123>`. Headings, tables and `[label](url)` do not render there. To post standard Markdown yourself,
send it as a `markdown` block instead: `"blocks":[{"type":"markdown","text":"## Heading\n| a | b |\n|---|---|"}]`
(12,000 characters at most), with a short plain `text` beside it for the notification. Keep replies short and
thread them.

## Being mentioned

When a message is addressed to the app (an @mention, a DM, or anything in a thread it works in), the gateway
wakes an agent conversation and **posts your reply into that message's thread for you**: just write your
answer, in standard Markdown (Slack shows it as written, tables included), and never post it yourself with curl
as well. While you work, a status card in the thread shows your steps and checklist, with a Stop button (or,
when the owner chose Slack's own streaming, your steps stream into the answer and a ⏹️ reaction on the request
stops you), so don't narrate each step. Use the commands above to act *elsewhere*: react, post to a different channel, DM someone.

Each thread is one continuing conversation: replies in it reach you with no new mention, and one sent while you
work arrives in the same turn. The event's `thread` field is the thread's root `ts`; post anything else into the
thread with `thread_ts` set to it.

Notes: `not_in_channel` means the bot hasn't been invited — ask the user to `/invite @intentic` there.
`missing_scope` names the scope the app lacks; it needs a reinstall from the app dashboard to add one.
