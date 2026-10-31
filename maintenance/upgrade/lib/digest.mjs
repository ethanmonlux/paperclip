import { createHash } from "node:crypto";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Key-sorted JSON so a record hashes the same after a write/read round trip.
function canonical(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Content identity of a JSON record (receipt, registry) for citation by reviews. */
export const canonicalDigest = (value) => sha256(canonical(value));
