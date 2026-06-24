import { describe, it, expect } from "vitest";
import { extractBearer } from "./jwtAuth";

describe("extractBearer", () => {
  it("pulls the token from the Authorization header (any case)", () => {
    expect(extractBearer({ authorization: "Bearer abc.def.ghi" })).toBe("abc.def.ghi");
    expect(extractBearer({ Authorization: "Bearer abc.def.ghi" })).toBe("abc.def.ghi");
  });
  it("throws when missing or malformed", () => {
    expect(() => extractBearer({})).toThrow("unauthorized");
    expect(() => extractBearer({ authorization: "Token x" })).toThrow("unauthorized");
  });
});
