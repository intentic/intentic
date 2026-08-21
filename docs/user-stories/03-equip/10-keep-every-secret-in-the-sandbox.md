# See every credential I have handed over, in one place

As someone who has now connected half a dozen things, I want one list of every secret my sandbox holds, so that "what does this thing know about me" has an answer I can read rather than infer.

The claim the whole product rests on is that credentials live in my sandbox and not on the platform. A claim like that is worth very little unless I can go and look, so the sandbox's secrets view is where the claim is cashed: the values my capabilities stored, the ones the AI accounts hold, and the ones I added myself, grouped by where they came from.

Reading a secret should be deliberate (masked by default, revealed when I ask) and the list should be searchable, because a sandbox that has been in use for a month has more of them than a screen holds. Anything I can change here should say what changing it affects, and getting back to the capability that owns a credential should be a link rather than a hunt.

## Acceptance criteria

- [ ] The sandbox has a secrets view listing what it holds, grouped by where each secret came from
- [ ] Credentials stored by capabilities appear in their own group, with a way back to where capabilities are managed
- [ ] Credentials held by AI provider accounts appear in their own group, with a way back to where accounts are managed
- [ ] Secret values are masked by default and revealed only on an explicit action
- [ ] The list can be filtered, and the filter can be cleared back to the full list
- [ ] A secret can be added by name and value, and appears in the list afterwards
- [ ] The view states that these values live in the sandbox rather than on the platform
- [ ] While the sandbox is unreachable, the view says so instead of showing an empty list that reads as "no secrets"
