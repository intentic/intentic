# See every credential I have handed over, in one place

As someone who has now connected half a dozen things, I want one list of every secret my sandbox holds, so that "what does this thing know about me" has an answer I can read rather than infer.

The claim the whole product rests on is that credentials live in my sandbox and not on the platform. A claim like that is worth very little unless I can go and look, so the sandbox's secrets view is where the claim is cashed: the values my capabilities stored, the ones the AI accounts hold, and the ones I added myself, grouped by where they came from.

There is one exception, and it is mine to make, one connection at a time (2026-11-27). Discord tells a bot about a
mention only over a connection that stays open, and a sandbox Intentic hosts sleeps when nobody uses it. On a hosted
sandbox the Discord card offers a switch, off until I turn it on, that says exactly what it does: "While this sandbox
sleeps, Intentic's servers hold this bot's token to notice a mention and wake the sandbox. The token is deleted when the
sandbox wakes." With it off, the token never leaves the sandbox. With it on, it leaves only as the sandbox goes to sleep
and only while a Discord automation is on, it is kept encrypted, and Intentic's servers keep where the messages for the
bot are, not what they say. No other credential leaves, and a sandbox on my own computer offers no such switch.

Reading a secret should be deliberate (masked by default, revealed when I ask) and the list should be searchable, because a sandbox that has been in use for a month has more of them than a screen holds. Anything I can change here should say what changing it affects, and getting back to the capability that owns a credential should be a link rather than a hunt.

## Acceptance criteria

- [ ] The sandbox has a secrets view listing what it holds, grouped by where each secret came from
- [ ] Credentials stored by capabilities appear in their own group, with a way back to where capabilities are managed
- [ ] Credentials held by AI provider accounts appear in their own group, with a way back to where accounts are managed
- [ ] Secret values are masked by default and revealed only on an explicit action
- [ ] The list can be filtered, and the filter can be cleared back to the full list
- [ ] A secret can be added by name and value, and appears in the list afterwards
- [ ] The view states that these values live in the sandbox rather than on the platform
- [ ] A Discord card on a hosted sandbox offers a switch, off by default, whose words say that Intentic's servers hold
      the bot's token while the sandbox sleeps and delete it when it wakes; with it off, or on a sandbox on my own
      computer, the token never leaves the sandbox
- [ ] While the sandbox is unreachable, the view says so instead of showing an empty list that reads as "no secrets"
