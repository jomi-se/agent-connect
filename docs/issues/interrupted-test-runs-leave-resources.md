# Interrupted test runs leave their resources behind

Status: needs-triage

A test run that is interrupted, or that hangs until something kills it, can
leave behind a running test gateway, its boxes and session networks, and
gigabytes of temporary folders. They stay for days, until someone notices the
disk or the container list.

Successful and failing runs clean up after themselves: fixture cleanup removes
only the containers whose recorded session ownership matches, shutdown waits for
the child to exit before removing its files, and CLI tests remove their roots
after an assertion failure. What is missing is interruption:

- A signal that arrives while a fixture is still allocating (building a box,
  creating a network, starting the gateway) finds no complete record of what
  exists yet, so cleanup misses whatever was half made.
- A runner that kills the whole process group, or a hang that ends in
  `SIGKILL`, runs no cleanup at all.

## What done looks like

- Allocation records each resource before or as it creates it, so a signal at
  any point can remove what exists.
- The next run finds and removes leftovers from earlier runs that this
  checkout owns, by recorded ownership and never by name pattern alone.
- A test interrupts a fixture mid-allocation and checks that nothing remains.
