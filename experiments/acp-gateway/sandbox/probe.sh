#!/usr/bin/env bash
# Q7: network policy probes from inside a session-shaped container.
# Starts a temporary canary listener on the host (all interfaces) so that
# "can the box reach the host" has something to hit. Run from
# experiments/acp-gateway after sandbox/up.sh.
set -uo pipefail
CANARY_PORT=18949
canary_dir=$(mktemp -d)
echo canary > "$canary_dir/canary.txt"
python3 -m http.server "$CANARY_PORT" --bind 0.0.0.0 -d "$canary_dir" >/dev/null 2>&1 &
canary_pid=$!
trap 'kill $canary_pid 2>/dev/null; rm -rf "$canary_dir"' EXIT
sleep 1

gw_internal=$(docker network inspect acp-internal -f '{{(index .IPAM.Config 0).Gateway}}')
gw_egress=$(docker network inspect acp-egress -f '{{(index .IPAM.Config 0).Gateway}}')
gw_docker0=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
host_tailnet=$(tailscale ip -4 2>/dev/null | head -1)

docker run --rm -i --network acp-internal --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges --user node \
  -e HTTPS_PROXY=http://egress:3128 -e HTTP_PROXY=http://egress:3128 -e NO_PROXY=mock \
  -e https_proxy=http://egress:3128 -e http_proxy=http://egress:3128 -e no_proxy=mock \
  --entrypoint bash acp-spike-session:dev -s -- "$gw_internal" "$gw_egress" "$gw_docker0" "${host_tailnet:-203.0.113.9}" "$CANARY_PORT" <<'PROBES'
gw_internal=$1; gw_egress=$2; gw_docker0=$3; host_tailnet=$4; port=$5
probe() { # label expected curl-args...
  local label=$1 expected=$2; shift 2
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' -m 6 "$@" 2>/dev/null); code=${code:-000}
  local verdict=FAIL; [[ "$code" =~ ^($expected)$ ]] && verdict=ok
  printf '%-4s %-58s got %s (want %s)\n' "$verdict" "$label" "$code" "$expected"
}
probe "public HTTPS via egress proxy"                  "200|301|302" https://example.com/
probe "public HTTPS bypassing the proxy"               "000"         --noproxy '*' https://example.com/
probe "mock model on the internal network (direct)"    "200"         --noproxy '*' http://mock:18931/v1/models
probe "cloud metadata 169.254.169.254 via proxy"       "403"         http://169.254.169.254/latest/meta-data/
probe "RFC1918 10.0.0.1 via proxy"                     "403"         http://10.0.0.1/
probe "RFC1918 192.168.1.1 via proxy"                  "403"         http://192.168.1.1/
probe "tailnet MagicDNS 100.100.100.100 via proxy"     "403"         http://100.100.100.100/
probe "host tailnet address via proxy"                 "403"         "http://$host_tailnet:$port/canary.txt"
probe "loopback via proxy (the proxy's own host)"      "403"         "http://127.0.0.1:$port/canary.txt"
probe "IPv6 loopback via proxy"                        "403"         "http://[::1]:$port/canary.txt"
probe "host via internal bridge gateway (direct)"      "000"         --noproxy '*' "http://$gw_internal:$port/canary.txt"
probe "host via internal bridge gateway via proxy"     "403"         "http://$gw_internal:$port/canary.txt"
probe "host via egress bridge gateway via proxy"       "403"         "http://$gw_egress:$port/canary.txt"
probe "host via docker0 gateway via proxy"             "403"         "http://$gw_docker0:$port/canary.txt"
probe "host via docker0 gateway (direct)"              "000"         --noproxy '*' "http://$gw_docker0:$port/canary.txt"
probe "DNS name resolving to loopback via proxy"       "403|502"     "http://localtest.me:$port/canary.txt"
PROBES
