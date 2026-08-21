# Be told which of these forty cards apply to me

As someone who has just checked their code into a fresh sandbox, I want the catalog to tell me which capabilities my own workspace already asks for, so that equipping the agent is a short guided list rather than a survey of every connector that exists.

The catalog is a wall of cards, and on the day it matters most I know least about which of them are mine. But my workspace already answers that: a repository's remote says where its code lives, a pipeline file identifies the instance it belongs to, a compose file says a container engine is wanted. So the page reads what is checked out and offers the answer as one thing to do, not as a badge somewhere in a grid I would have to go looking through first.

Each suggestion arrives with the thing that was read to make it. That is the difference between advice I can act on and advice I have to take on faith: if the claim is wrong I can see that it is wrong, from the path or the remote printed under it. Nothing is enabled for me, and no credential is ever filled in on my behalf, but everything that is not a credential is, so the instance URL I would otherwise go and look up is already in the field.

Saying no has to work as well as saying yes. A suggestion I decline goes quiet, and stays quiet until the thing behind it changes: because a strip that asks the same question every time I open the page is one I will learn to stop reading.

## Acceptance criteria

- [ ] With capabilities its workspace asks for, the catalog offers them as a single set with a count, above the filter
- [ ] Each suggestion names both the claim and the artifact it was read from, and the artifact is shown verbatim
- [ ] Starting the setup opens the first suggested card, and finishing or skipping one moves to the next
- [ ] A card opened this way is pre-filled with everything the scan could read, and its credential fields are empty
- [ ] The step says how many are left, and offers a way past a card without answering it
- [ ] Declining a suggestion takes it off the catalog and does not offer it again on the next visit
- [ ] A declined suggestion returns by itself once the workspace evidence behind it has changed
- [ ] A suggested capability that gets connected stops being suggested
- [ ] With nothing to suggest, the catalog shows no setup offer at all rather than an empty one
