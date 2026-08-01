# Let the agent query my database, and see where the password went

As someone connecting a production-adjacent database, I want to know that the credential stays inside my own sandbox, so that handing over a database password is a decision I can defend.

The data cards ask for the things a connection string is made of — host, port, user, password, database — as separate fields, because a pasted URL hides which half is wrong when it fails. The password field is masked, and the page states plainly that what I enter is stored in my sandbox and nowhere else. That claim is the entire reason this product can be given a database at all.

Querying a database also needs a client in the image, so this is one of the capabilities that can be configured and still not be ready. That state has to be legible: an instance waiting on a rebuild should say that it is waiting on a rebuild, and point at where the rebuild happens, rather than reading as a connection that simply does not work.

## Acceptance criteria

- [ ] The Data section lists the database cards with a line saying what the agent will be able to do
- [ ] The form asks for host, port, user, password and database as separate fields, with the password masked
- [ ] The page states that the credential is stored only inside the sandbox
- [ ] A port outside the valid range is rejected with a message naming the range, before the form is submitted
- [ ] Leaving a required field empty and submitting reveals which fields are missing rather than doing nothing visible
- [ ] A card serving more than one engine lets the engine be chosen, and the choice is carried into the connection
- [ ] The form lists what connecting will add to the sandbox, including anything that must be installed for it
- [ ] An instance that needs a sandbox rebuild before it can work says so and links to where that is done
- [ ] With a connection active and its client installed, asking the agent to list the database's tables returns real results
