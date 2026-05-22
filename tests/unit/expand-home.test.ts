import { describe, test, expect } from "bun:test";
import { expandHome } from "../../src/server/config";
import { homedir } from "node:os";

describe("expandHome", () => {
  test("expands leading ~/", () => {
    expect(expandHome("~/foo/bar")).toBe(`${homedir()}/foo/bar`);
  });
  test("leaves absolute paths alone", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
  test("leaves relative paths alone", () => {
    expect(expandHome("rel/path")).toBe("rel/path");
  });
  test("does not expand ~user form", () => {
    expect(expandHome("~user/foo")).toBe("~user/foo");
  });
});
