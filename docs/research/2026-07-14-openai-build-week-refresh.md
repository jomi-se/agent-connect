# OpenAI Build Week live requirements refresh

Fetched through the Devpost Hackathons plugin on 2026-07-14 at approximately
23:35 UTC. The official source is <https://openai.devpost.com>.

## Current state and dates

- Status: submissions open.
- Submission window: 2026-07-13 16:00 UTC through 2026-07-22 00:00 UTC
  (July 21, 5:00 PM Pacific Time).
- Judging: 2026-07-22 17:00 UTC through 2026-08-06 00:00 UTC (July 22 at
  10:00 AM through August 5 at 5:00 PM Pacific Time). Corrected against the
  live formal rules on 2026-07-15; the earlier plugin result ended this period
  five days too late.
- Winners announced: 2026-08-12 21:00 UTC.
- One announcement was available. It incorrectly called July 21 a Monday; the
  formal timestamp and overview say Tuesday. Use the timestamp.

## Judging criteria

1. Technological Implementation: thorough, skillful Codex use and a working,
   non-trivial implementation.
2. Design: a coherent runnable product, not only a proof of concept.
3. Potential Impact: a credible real problem, audience, and demonstrated fit.
4. Quality of the Idea: creativity and genuine understanding of the space.

Agent Connect remains best positioned in **Developer Tools**, whose description
explicitly includes agentic workflows and security.

## Live submission fields

Required custom fields:

- 27945 — submitter type;
- 27946 — country of residence;
- 27947 — category;
- 27948 — repository URL;
- 27950 — `/feedback` session ID.

Developer-tool testing instructions are field 27951. A judge test URL and
private instructions may be supplied in field 27949. The submission requires a
video but not a website or zip file.

The public YouTube video must be shorter than three minutes and include audio
covering what was built, how Codex was used, and how GPT-5.6 was used. The repo
must be public with relevant licensing or private and shared with
`testing@devpost.com` and `build-week-event@openai.com`. A developer tool also
needs installation instructions, supported platforms, and a judge-accessible
way to test without rebuilding from scratch.

## Remaining submission-critical work

1. Finish the gateway authorization flow on the deployed Firebase/tailnet
   surface and capture mobile screenshots/video.
2. Choose the final demo: the current Canvas flow is submission-safe; the
   spreadsheet + durable action recovery is stronger but only if finished.
3. Add an open-source license and submission-oriented README sections.
4. Produce a judge-accessible runtime or a deterministic hosted/mock sandbox
   that does not expose the owner's Codex subscription.
5. Obtain the `/feedback` identifier from the primary Codex build session.
6. Record and upload the narrated under-three-minute demo.
7. Fill fields 27945–27951 as applicable, recheck announcements/rules, and
   submit rather than leaving a draft.

Eligibility is intentionally not determined here. The entrant must read and
agree to the official rules and confirm age, residence, employment/conflict,
ownership, and licensing requirements personally.
