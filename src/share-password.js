// Password generation for hosted shares. A share password is read out of a chat message and
// typed into the host's viewer gate by hand, so it is grouped and drawn from an alphabet with
// no glyph pair a person can transcribe wrongly (0/o, 1/l/i are all absent). Twelve characters
// of a 31-character alphabet is ~59 bits, well past what a guess-limited viewer gate needs.
import { randomInt } from "node:crypto";

export const SHARE_PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const GROUPS = 3;
const GROUP_LENGTH = 4;

export function generateSharePassword() {
  const groups = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let chunk = "";
    for (let i = 0; i < GROUP_LENGTH; i += 1) {
      chunk += SHARE_PASSWORD_ALPHABET[randomInt(SHARE_PASSWORD_ALPHABET.length)];
    }
    groups.push(chunk);
  }
  return groups.join("-");
}
