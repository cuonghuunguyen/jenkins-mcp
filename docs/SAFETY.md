# Safety

[← README](../README.md)


- **The write surface is three endpoints.** `POST /job/<path>/build`,
  `POST /job/<path>/buildWithParameters`, and `POST /job/<path>/<n>/stop`.
  Nothing else in the codebase issues a mutating request, and a test walks the
  whole write surface to assert it.
- **Two tools write, and only those two issue a non-GET request at all.** No
  qualification. `jenkins_whoami` used to POST to `/me/api/json` to exercise
  the crumb round-trip, and it is registered in read-only mode, so the claim
  was false on the first call an agent makes; it now GETs. The assertion is
  **behavioural**, not a name comparison: the safety test invokes every
  read-only tool's operation against a client whose `post` fails the test if it
  is called. The name-list version of that assertion could not have caught the
  whoami POST, and did not.
- **`JENKINS_MCP_READONLY=1` unregisters both write tools**, leaving 9 that
  reach zero POST endpoints — asserted in both modes rather than documented and
  hoped for.
- **No create, update or delete.** The server cannot make, edit or remove a
  job, a credential, a view, a node or any configuration. `/term` and `/kill`
  are never constructed.
- **`jenkins_api_get` is GET-only and validated.** An absolute URL, a
  protocol-relative `//host`, a `..` segment in any encoding, and an embedded
  query string are all rejected — the client carries an `Authorization`
  header, so an absolute URL would be an SSRF that leaks credentials. `tree=`
  is mandatory for `api/json`, `api/xml` and `api/python`, checked against the
  path a servlet container would actually route, so `/queue/api//json` and
  `/queue/api/json;x=y` cannot smuggle an unprojected read past it.
- **`save_to` is contained to the cwd.** Absolute paths, `..` traversal, a
  symlinked directory whose real target is outside the cwd, and a hardlink to
  a file outside the cwd are all rejected before anything is written.
- **Errors carry no secrets by construction.** An error message is built only
  from an HTTP status plus an operation label. A `Response`, a `Headers`, a
  thrown error object, a token, a crumb and a cookie are never interpolated
  into one. Header logging uses an allowlist of known-safe names, so a new
  secret-bearing header is redacted by default.
- **Password-class build parameters are redacted** in the returned data, so
  `--json` and the permanent cache hold `[redacted]` too.
- **stdout is the JSON-RPC channel.** Only `console.error` is permitted in the
  codebase, enforced by biome, and a spawned-server test asserts that stdout
  carries nothing but well-formed JSON-RPC frames.

If you ever see a raw token, crumb or cookie **value** on stderr, that is a bug
worth reporting, not expected output.
