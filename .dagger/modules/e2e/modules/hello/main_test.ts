import { greet } from "./main.ts";

Deno.test("greet returns a greeting", () => {
  if (greet("world") !== "Hello, world!") {
    throw new Error("unexpected greeting");
  }
});
