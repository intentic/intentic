# Know that a capability will restart my sandbox before I click it

As someone adding the capabilities that change the sandbox itself, I want to be told what is about to be installed, rebuilt or scaffolded, so that a click I thought was configuration does not turn into a five-minute restart I did not plan.

The Platform section is the consequential one. DevOps scaffolds repositories. The monorepo card creates one. Docker restarts the sandbox privileged, with its own engine. These are not connections — they change what the box is — so each card carries its consequences on its face in the catalog, before I have opened it, and again in full inside the form.

Applying one is not instant and does not pretend to be. The progress is real output from a real shell, in a terminal I can watch, because "installing…" with a spinner is exactly where I would otherwise start wondering whether it had hung. And when a capability needs a rebuild before it can work, it says so where I can act on it rather than sitting at "pending" forever.

## Acceptance criteria

- [ ] The catalog groups cards into named sections with a line saying what each section is for, and Platform is one of them
- [ ] A card whose effects include installing into the image, restarting the sandbox, or running code carries that as a marker on the card itself, before it is opened
- [ ] Opening a card shows the full list of what it will add to the sandbox, above the action that applies it
- [ ] Applying a capability that runs a real command opens its terminal, so the actual output is watchable
- [ ] A capability that has been applied appears as a connected instance with a state
- [ ] An instance that cannot finish until the sandbox is rebuilt says so, and links to where the rebuild is done
- [ ] Removing a capability asks for confirmation first, and says that the removal tears down its configuration
- [ ] The page says that everything configured here is stored only in the sandbox
