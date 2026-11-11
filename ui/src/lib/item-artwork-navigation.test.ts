import { describe, expect, it } from "vitest";
import { itemArtworkReturnPath } from "./item-artwork-navigation";

const origin = "https://staple.example";

describe("Item artwork return path", () => {
  it("keeps an in-app source with its search and filter state", () => {
    expect(itemArtworkReturnPath("/STA/issues?q=items&status=open#selected", "STA", origin))
      .toBe("/STA/issues?q=items&status=open#selected");
  });

  it.each([null, "", "https://external.example/STA/issues", "//external.example/STA/issues", "/OTHER/issues", "/STA/item-artwork", "/STA/../OTHER/issues"])(
    "falls back to Console for direct, external, foreign-company or self entry: %s",
    (value) => expect(itemArtworkReturnPath(value, "STA", origin)).toBeNull(),
  );
});
