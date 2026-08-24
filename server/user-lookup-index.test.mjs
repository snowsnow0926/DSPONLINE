import assert from "node:assert/strict";
import test from "node:test";
import { UserLookupIndex } from "./user-lookup-index.mjs";

function user(id, username, email = "") {
  return { id, username, email };
}

test("user lookup index rebuilds deterministic username/email maps and preserves fallback semantics", () => {
  const users = {
    user_b: user("user_b", "Bravo", "bravo@example.com"),
    user_a: user("user_a", "Alpha", "alpha@example.com"),
    user_c: user("user_c", "Charlie", "shared@example.com"),
    user_d: user("user_d", "Delta", "shared@example.com"),
  };
  const index = new UserLookupIndex();
  index.rebuild(users);

  assert.equal(index.findByUsername("alpha", users)?.id, "user_a");
  assert.equal(index.findByEmail("BRAVO@EXAMPLE.COM", users)?.id, "user_b");
  // Duplicate legacy emails retain the source-object insertion order.
  assert.equal(index.findByEmail("shared@example.com", users)?.id, "user_c");
  assert.equal(index.hasUsername("missing", users), false);
  assert.equal(index.diagnostics().indexedHits, 3);
});

test("upsert/delete and a stale miss repair the runtime index without changing the users authority", () => {
  const users = { user_a: user("user_a", "Alpha", "alpha@example.com") };
  const index = new UserLookupIndex();
  index.rebuild(users);

  users.user_b = user("user_b", "Bravo", "bravo@example.com");
  // Simulate an observer arriving late: the first lookup falls back and
  // repairs the missing entry, so authentication cannot fail closed.
  assert.equal(index.findByUsername("bravo", users)?.id, "user_b");
  assert.equal(index.findByEmail("bravo@example.com", users)?.id, "user_b");

  users.user_a.email = "new@example.com";
  index.upsert(users.user_a);
  assert.equal(index.findByEmail("alpha@example.com", users), null);
  assert.equal(index.findByEmail("new@example.com", users)?.id, "user_a");

  delete users.user_b;
  index.delete("user_b");
  assert.equal(index.findByUsername("bravo", users), null);
  assert.ok(index.diagnostics().fallbackScans >= 2);
});

test("large synthetic account set keeps hot lookups indexed", () => {
  const users = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => {
    const id = `user_${index}`;
    return [id, user(id, `pilot_${index.toString(36).padStart(4, "0")}`, `${index}@example.com` )];
  }));
  const lookup = new UserLookupIndex();
  lookup.rebuild(users);
  const startedAt = performance.now();
  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(lookup.findByUsername(`PILOT_${index.toString(36).padStart(4, "0")}`, users)?.id, `user_${index}`);
  }
  assert.ok(performance.now() - startedAt < 500, `indexed lookups unexpectedly slow: ${performance.now() - startedAt}ms`);
  assert.equal(lookup.diagnostics().fallbackScans, 0);
});

