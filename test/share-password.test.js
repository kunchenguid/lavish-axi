import assert from "node:assert/strict";
import test from "node:test";

import { SHARE_PASSWORD_ALPHABET, generateSharePassword } from "../src/share-password.js";

test("generateSharePassword returns grouped characters a person can read aloud and retype", () => {
  const password = generateSharePassword();

  assert.match(password, /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
  for (const character of password.replace(/-/g, "")) {
    assert.ok(SHARE_PASSWORD_ALPHABET.includes(character), `${character} is not in the share password alphabet`);
  }
});

test("the share password alphabet excludes glyphs that are misread when the password is relayed", () => {
  for (const ambiguous of ["0", "o", "1", "l", "i"]) {
    assert.ok(!SHARE_PASSWORD_ALPHABET.includes(ambiguous), `${ambiguous} is too easy to mistype`);
  }
  assert.ok(SHARE_PASSWORD_ALPHABET.length >= 30, "the alphabet must stay wide enough to keep the entropy budget");
});

test("generateSharePassword does not repeat itself", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(generateSharePassword());
  assert.equal(seen.size, 200);
});
