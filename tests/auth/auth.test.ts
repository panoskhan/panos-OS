import assert from "node:assert/strict";
import test from "node:test";
import { ApiKeyAuth, AuthConfigError, bearerToken } from "../../services/auth/src/index";

const EXAMPLE = "admin:secret123,readonly:readkey456";

test("the example from the spec parses into two named keys", () => {
  const auth = ApiKeyAuth.parse(EXAMPLE);

  assert.equal(auth.enabled, true);
  assert.deepEqual(auth.names(), ["admin", "readonly"]);
  assert.deepEqual(auth.authenticate("secret123"), { name: "admin" });
  assert.deepEqual(auth.authenticate("readkey456"), { name: "readonly" });
});

test("nothing configured means auth is off", () => {
  for (const raw of [undefined, "", "   ", ",", " , ,"]) {
    const auth = ApiKeyAuth.parse(raw);
    assert.equal(auth.enabled, false, JSON.stringify(raw));
    assert.deepEqual(auth.names(), []);
    assert.equal(auth.authenticate("anything"), null);
  }
  assert.equal(ApiKeyAuth.disabled().enabled, false);
  assert.equal(ApiKeyAuth.fromEnv({}).enabled, false);
  assert.equal(ApiKeyAuth.fromEnv({ KHAN_API_KEYS: "" }).enabled, false);
  assert.equal(ApiKeyAuth.fromEnv({ KHAN_API_KEYS: EXAMPLE }).enabled, true);
});

test("whitespace and stray commas are tolerated, and a key may contain colons", () => {
  const auth = ApiKeyAuth.parse(" admin : secret123 ,, svc:abc:def:ghi , ");

  assert.deepEqual(auth.names(), ["admin", "svc"]);
  assert.deepEqual(auth.authenticate("secret123"), { name: "admin" }, "spaces around the name and the key are ignored");
  assert.deepEqual(auth.authenticate("abc:def:ghi"), { name: "svc" });
});

test("only an exact key authenticates", () => {
  const auth = ApiKeyAuth.parse(EXAMPLE);

  for (const wrong of ["", "secret12", "secret1234", "SECRET123", "secret123 ", "xsecret123", "readkey456secret123", "admin", "admin:secret123", "\u0000"]) {
    assert.equal(auth.authenticate(wrong), null, JSON.stringify(wrong));
  }
  assert.equal(auth.authenticate(undefined), null);
  assert.equal(ApiKeyAuth.disabled().authenticate("secret123"), null, "a disabled auth authenticates nobody (the caller skips it)");
});

test("keys of very different lengths compare without error", () => {
  const auth = ApiKeyAuth.parse(`short:a,long:${"k".repeat(5000)}`);

  assert.deepEqual(auth.authenticate("a"), { name: "short" });
  assert.deepEqual(auth.authenticate("k".repeat(5000)), { name: "long" });
  assert.equal(auth.authenticate("k".repeat(5001)), null);
  assert.equal(auth.authenticate("ab"), null);
});

test("malformed entries are rejected, and the error names the entry but never shows a key", () => {
  const cases: Array<[string, RegExp]> = [
    ["admin", /entry 1 must look like name:key/],
    ["admin:", /entry 1 must look like name:key/],
    [":supersecretkey", /entry 1 must look like name:key/],
    ["ok:okkey1234,brokenentrywithsecret", /entry 2 must look like name:key/],
    ["admin:super secret key", /entry 1: the key must not contain spaces/],
    ["bad name:supersecretkey", /entry 1: the name must start with a letter or digit/],
    ["-lead:supersecretkey", /entry 1: the name must start with a letter or digit/],
    ["a/b:supersecretkey", /entry 1: the name must start with a letter or digit/],
    [`${"n".repeat(65)}:supersecretkey`, /the name must start with a letter or digit/],
    ["system:supersecretkey", /entry 1: the name 'system' is reserved/],
    ["Anonymous:supersecretkey", /entry 1: the name 'Anonymous' is reserved/],
    ["admin:supersecretkey,ADMIN:othersecretkey", /entry 2: the name 'ADMIN' is used twice/],
    ["admin:supersecretkey,other:supersecretkey", /entry 2 uses the same key as an earlier entry/]
  ];

  for (const [raw, expected] of cases) {
    assert.throws(
      () => ApiKeyAuth.parse(raw),
      (error: unknown) => {
        assert.ok(error instanceof AuthConfigError, raw);
        assert.match(error.message, expected, raw);
        assert.ok(!/secretkey|secret1|entrywithsecret/.test(error.message), `the error leaked a key: ${error.message}`);
        return true;
      },
      raw
    );
  }
});

test("names are accepted with letters, digits, underscore, dot and dash", () => {
  const auth = ApiKeyAuth.parse("ci-bot_2.prod:key-one,9lives:key-two");

  assert.deepEqual(auth.names(), ["ci-bot_2.prod", "9lives"]);
});

test("reading a bad KHAN_API_KEYS from the environment fails instead of turning auth off", () => {
  assert.throws(() => ApiKeyAuth.fromEnv({ KHAN_API_KEYS: "oops" }), AuthConfigError);
});

test("the Bearer token is read from the Authorization header", () => {
  assert.equal(bearerToken("Bearer secret123"), "secret123");
  assert.equal(bearerToken("bearer secret123"), "secret123", "the scheme is case-insensitive");
  assert.equal(bearerToken("BEARER   secret123  "), "secret123");
  assert.equal(bearerToken("Bearer a:b:c"), "a:b:c");

  for (const header of [undefined, "", "Bearer", "Bearer ", "Basic secret123", "secret123", "Bearer two words", "Bearersecret123", "Token secret123"]) {
    assert.equal(bearerToken(header), undefined, JSON.stringify(header));
  }
});
