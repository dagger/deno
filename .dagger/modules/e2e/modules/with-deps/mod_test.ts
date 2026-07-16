import { assertEquals } from "@std/assert";
import { double } from "./mod.ts";

Deno.test("double doubles its input", () => {
  assertEquals(double(3), 6);
});
