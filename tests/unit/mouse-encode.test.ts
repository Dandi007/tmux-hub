import { describe, test, expect } from "bun:test";
import { encodeWheel } from "../../src/server/mouse-encode";

const ESC = "\x1b";

describe("encodeWheel", () => {
  test("wheel up uses SGR button 64 with 1-based col/row", () => {
    expect(encodeWheel("up", 1, 10, 5)).toBe(`${ESC}[<64;10;5M`);
  });

  test("wheel down uses SGR button 65", () => {
    expect(encodeWheel("down", 1, 10, 5)).toBe(`${ESC}[<65;10;5M`);
  });

  test("notches repeats the report N times", () => {
    expect(encodeWheel("down", 3, 2, 2)).toBe(
      `${ESC}[<65;2;2M${ESC}[<65;2;2M${ESC}[<65;2;2M`,
    );
  });

  test("non-positive notches produce no output", () => {
    expect(encodeWheel("up", 0, 1, 1)).toBe("");
    expect(encodeWheel("up", -2, 1, 1)).toBe("");
  });

  test("fractional notches are floored", () => {
    expect(encodeWheel("up", 2.9, 1, 1)).toBe(`${ESC}[<64;1;1M${ESC}[<64;1;1M`);
  });
});
