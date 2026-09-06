# Adversarial review — 2026-09-05

Direct review of OAuth, credential storage, X API client, tool schemas, transports, tests, and packaging. No CodeRabbit review was used. Severity assumes the documented local, single-user deployment.

| Severity | Finding                                                                                                                                                                  | Resolution                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | HTTP adapter buffered authenticated request bodies without a size limit; upstream JSON parsing was also unbounded.                                                       | Enforce 128 KiB HTTP bodies including chunked uploads, a 15-second body deadline, 2 MiB X responses, and 64 KiB token responses. Reject unsupported media types and compression.              |
| Medium   | Credential reads accepted insecure files and malformed token structures.                                                                                                 | Validate directory/file ownership and permissions on POSIX, reject symlinks/nonregular files, open without following symlinks and without blocking on FIFOs, and validate stored credentials. |
| Medium   | OAuth completion depended on response delivery; a disconnected browser could strand the authentication lock. Malformed callback URLs could throw outside error handling. | Settle login independently of response delivery, reject malformed callbacks, clean up display failures and interruption, and retain the lock during an active exchange.                       |
| Medium   | Errors-only X responses and missing DM receipts could appear successful.                                                                                                 | Mark errors-only tool results as failures while preserving partial data; report unknown delivery for invalid send receipts without retrying.                                                  |
| Low      | DM schemas accepted unknown fields and had inconsistent ID/text constraints.                                                                                             | Use strict MCP objects, align numeric ID/cursor limits, and validate nonblank text by Unicode code point.                                                                                     |

## Verification

24 tests pass, including oversized fixed/chunked HTTP uploads, malformed JSON and callback URLs, OAuth browser disconnects, failed authorization display, insecure credential permissions/symlinks, malformed stored tokens, oversized upstream streams, errors-only/partial results, and missing send receipts. Existing tests cover PKCE/state, serialized refresh, write gating, redaction, pagination, post filters, and modern/legacy MCP transports. Type checking and formatting pass. `npm audit --json` reports zero known vulnerabilities in the locked dependency graph at review time.

The current [X recent-search reference](https://docs.x.com/x-api/posts/search-recent-posts) specifies `post.fields` and `note_post`, matching the implementation; some quickstart examples still use older field names.

## Remaining limits

No real X account requests or live Claude/Codex sessions were performed. Credentials remain plaintext; owner permissions are not encryption or protection against another process running as the same user. Windows ACLs are not verified. A hard process kill can leave an authentication lock requiring manual recovery. HTTP is loopback-only and is not a public multi-user OAuth service. Host approval remains responsible for authorizing each send; the write flag alone does not prove user consent.
