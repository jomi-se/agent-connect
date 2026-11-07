# 02 Run the gateway scenarios concurrently

Status: ready-for-agent

The scenarios gate runs its scenarios one after another, and it is the
slowest gate job. Each scenario owns its own gateway, home and boxes, so most
could run side by side.

Run them concurrently, with a bounded pool, keeping each scenario's isolation
(own HOME and XDG state, own ports, own containers) and its cleanup. A failure
must still name the scenario and show only its output, not the others'
interleaved with it. Scenarios that cannot share a host (fixed ports, the
whole container engine) stay serial and say why.
