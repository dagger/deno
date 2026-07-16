import { describe } from "./mod.ts";

Deno.test("describe uses the cross-member util package", () => {
  if (describe(3) !== "util:3") {
    throw new Error("unexpected describe output");
  }
});
