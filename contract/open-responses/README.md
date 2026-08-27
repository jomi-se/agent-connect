# Pinned Open Responses fixture

`openapi.json` is vendored verbatim from the Open Responses repository so that
gateway tests validate produced resources and events against the standard's own
schemas rather than against remembered protocol semantics.

| Property        | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| Repository      | <https://github.com/openresponses/openresponses>                          |
| Commit          | `92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c`                                |
| Path            | `public/openapi/openapi.json`                                             |
| OpenAPI version | `3.1.0`                                                                   |
| `info.version`  | `2026-04-24`                                                              |
| Checksum        | `sha256:693f26090d206230ed22b336681f547a2882cf5b131e86743966cf71bbdeedab` |

To refresh the pin:

```sh
curl -sSfL -o contract/open-responses/openapi.json \
  https://raw.githubusercontent.com/openresponses/openresponses/<commit>/public/openapi/openapi.json
sha256sum contract/open-responses/openapi.json
```

Then update the checksum here, in
[the vertical-slice plan](../../docs/plan/open-responses-vertical-slice.md), and in
`packages/gateway/test/open-responses-fixture.test.ts`, which fails if the file
drifts from the recorded checksum.

The file is listed in `.prettierignore`: it must stay byte-identical to the
upstream document or the checksum stops meaning anything.
