Deno.test("net permission is granted from deno.json (via -P)", async () => {
  const status = await Deno.permissions.query({ name: "net" });
  if (status.state !== "granted") {
    throw new Error(
      `expected net granted from deno.json, got: ${status.state}`,
    );
  }
});
