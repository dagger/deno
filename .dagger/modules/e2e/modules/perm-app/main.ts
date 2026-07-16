const status = await Deno.permissions.query({ name: "net" });
console.log("NET:" + status.state);
