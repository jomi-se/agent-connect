# VAL-JUDGE-001: A clean public browser reaches only the judge gateway

Surface: browser and operator.
Needs: Firebase Canvas deployment, containerized judge stack on host loopback,
and Tailscale Funnel on the reserved public port.
Behavior: a clean browser outside the developer's tailnet can import the judge
runtime card, verify the gateway challenge over valid HTTPS, and begin
authorization without a local-network permission prompt. Funnel reaches only
the loopback-published judge gateway; private Serve routes and raw Omnigent
ports remain inaccessible.
Evidence: clean-device URL and TLS capture, browser console/network capture,
Funnel status, host listening sockets, and container port/network inspection.

Fail: tailnet membership is required, the browser receives a mixed-content or
local-network prompt, a container port is published beyond host loopback, or a
raw provider/private gateway endpoint is publicly reachable.
Scope: Funnel supplies public HTTPS, not requester identity.
