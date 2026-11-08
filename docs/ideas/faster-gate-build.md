# Build the gateway faster for the gates on ordinary pushes

Status: needs-triage

The "Gateway release build" job builds the gateway with the release recipe
(`dist build`, the `dist` profile: release with thin LTO) and packs the npm
tarballs that the four gate jobs test. It takes about 5 of CI's 11 minutes,
and every gate waits for it.

The optimization doesn't buy much on an ordinary push. The release workflow
never reuses CI's binary: it builds every target again with `dist build`.
So the gates test the same recipe as what ships, never the same bytes.

## Proposal

- On a push whose versions are all on npm already, build the gateway for the
  gates without optimization or LTO, and pack the same tarballs around it.
- On a push with an unpublished version, which is the commit Release
  publishes, keep the `dist` recipe, so the released commit's gates test the
  optimization level that ships. Timing-sensitive scenarios
  ([lateask-cut](../issues/lateask-cut-races-tool-listing.md)) can behave
  differently between the two builds.
- CI's plan job already hashes the inputs; finding unpublished versions is
  what Release's plan step does now.

## Open

- How long an unoptimized build takes in CI. Measure before deciding; the
  saving is an estimate.
- Whether the box image and clean room care which profile built the binary.
