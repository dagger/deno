import {
  parseJUnit,
  parseStdout,
  type Run,
  type Selection,
  summarize,
  tail,
} from "./main.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const selections: Selection[] = [
  { key: "p/a_test.ts", file: "./a_test.ts" },
  { key: "p/b_test.ts", file: "./b_test.ts" },
];

function junit(...cases: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="deno test">\n${
    cases.join("\n")
  }\n</testsuites>\n`;
}

const pass = (file: string, name = "ok") =>
  `<testcase name="${name}" classname="${file}" time="0.000"></testcase>`;
const fail = (file: string, name: string, text: string) =>
  `<testcase name="${name}" classname="${file}" time="0.000">\n<failure message="m">${text}</failure>\n</testcase>`;

function run(partial: Partial<Run>): Run {
  return {
    report: junit(),
    stdout: "",
    stderr: "",
    exitCode: 0,
    failFast: false,
    ...partial,
  };
}

Deno.test("parses escaped test cases, failures and skips", () => {
  const cases = parseJUnit(junit(
    fail("./a_test.ts", "fails &lt;&amp;&gt;", "Error: boom &amp; &lt;bad&gt;"),
    `<testcase name="skipped" classname="./a_test.ts" time="0"><skipped/></testcase>`,
    `<testcase name="bare" classname="./b_test.ts"/>`,
  ));
  assert(cases.length === 3, `cases: ${JSON.stringify(cases)}`);
  assert(
    cases[0].name === "fails <&>" && cases[0].failure === "Error: boom & <bad>",
    JSON.stringify(cases[0]),
  );
  assert(
    cases[1].failure === null && cases[2].file === "./b_test.ts",
    JSON.stringify(cases),
  );
});

Deno.test("a failing file fails only its own check", () => {
  const results = summarize(
    run({
      report: junit(
        fail("./a_test.ts", "broken", "selected failure"),
        pass("./b_test.ts"),
      ),
      exitCode: 1,
    }),
    selections,
  );
  assert(
    results.get("p/a_test.ts")!.includes("selected failure"),
    results.get("p/a_test.ts")!,
  );
  assert(results.get("p/b_test.ts") === "", results.get("p/b_test.ts")!);
});

Deno.test("a missing report fails every check", () => {
  const results = summarize(
    run({ report: null, exitCode: 1, stderr: "TS2322 [ERROR]" }),
    selections,
  );
  for (const s of selections) {
    assert(results.get(s.key)!.includes("TS2322"), results.get(s.key)!);
  }
});

Deno.test("a failure outside the selected files fails every check", () => {
  const results = summarize(
    run({
      report: junit(
        pass("./a_test.ts"),
        pass("./b_test.ts"),
        fail("./helper.ts", "shared", "helper failure"),
      ),
      exitCode: 1,
    }),
    selections,
  );
  for (const s of selections) {
    assert(
      results.get(s.key)!.includes(
        "failures outside the selected test files: ./helper.ts",
      ),
      results.get(s.key)!,
    );
    assert(results.get(s.key)!.includes("helper failure"), results.get(s.key)!);
  }
});

Deno.test("an uncaught error fails only the file that threw", () => {
  const stdout = [
    "running 1 test from ./a_test.ts",
    "ok ... ok (1ms)",
    "Uncaught error from ./b_test.ts FAILED",
    "",
    " ERRORS ",
    "",
    "./b_test.ts (uncaught error)",
    "error: (in promise) Error: top level throw",
    "",
    " FAILURES ",
  ].join("\n");
  const results = summarize(
    run({ report: junit(pass("./a_test.ts")), stdout, exitCode: 1 }),
    selections,
  );
  assert(results.get("p/a_test.ts") === "", results.get("p/a_test.ts")!);
  assert(
    results.get("p/b_test.ts")!.includes("top level throw"),
    results.get("p/b_test.ts")!,
  );
});

Deno.test("a selected file deno never ran fails as not run", () => {
  const results = summarize(
    run({ report: junit(pass("./a_test.ts")) }),
    selections,
  );
  assert(results.get("p/a_test.ts") === "", results.get("p/a_test.ts")!);
  assert(
    results.get("p/b_test.ts")!.includes("did not run"),
    results.get("p/b_test.ts")!,
  );
});

Deno.test("a file that ran with no tests of its own passes", () => {
  const stdout =
    "running 0 tests from ./a_test.ts\nrunning 1 test from ./b_test.ts\n";
  const results = summarize(
    run({ report: junit(pass("./helper.ts")), stdout }),
    selections,
  );
  for (const s of selections) {
    assert(results.get(s.key) === "", results.get(s.key)!);
  }
});

Deno.test("a failing exit with nothing attributed fails every check", () => {
  const results = summarize(
    run({
      report: junit(pass("./a_test.ts"), pass("./b_test.ts")),
      exitCode: 3,
    }),
    selections,
  );
  for (const s of selections) {
    assert(results.get(s.key)!.includes("exit 3"), results.get(s.key)!);
  }
});

Deno.test("fail-fast gaps are not blamed on files that never started", () => {
  const report = junit(fail("./a_test.ts", "broken", "first failure"));
  const stopped = summarize(
    run({ report, exitCode: 1, failFast: true }),
    selections,
  );
  assert(
    stopped.get("p/a_test.ts")!.includes("first failure"),
    stopped.get("p/a_test.ts")!,
  );
  assert(stopped.get("p/b_test.ts") === "", stopped.get("p/b_test.ts")!);
  const full = summarize(run({ report, exitCode: 1 }), selections);
  assert(
    full.get("p/b_test.ts")!.includes("no result"),
    full.get("p/b_test.ts")!,
  );
});

Deno.test("diagnostics stay bounded", () => {
  const huge = "x".repeat(1 << 20);
  assert(tail(huge).length < 33 << 10, "tail was not bounded");
  const results = summarize(
    run({ report: null, exitCode: 1, stdout: huge, stderr: huge }),
    selections,
  );
  for (const s of selections) {
    assert(
      results.get(s.key)!.length <= (96 << 10) + 64,
      "result was not bounded",
    );
  }
});

Deno.test("parses started modules and uncaught details from colored output", () => {
  const { started, uncaught } = parseStdout(
    "\x1b[0m\x1b[38;5;245mrunning 2 tests from ./a_test.ts\x1b[0m\nUncaught error from ./c_test.ts \x1b[0m\x1b[31mFAILED\x1b[0m\n",
  );
  assert(started.has("./a_test.ts"), [...started].join(","));
  assert(uncaught.has("./c_test.ts"), [...uncaught.keys()].join(","));
});

Deno.test("a helper's failing test fails the test modules that ran it", () => {
  const report = junit(
    pass("./a_test.ts", "own"),
    fail("./helper.ts", "shared", "helper failure"),
    fail("./helper.ts", "steps &gt; inner", "step failure"),
    pass("./b_test.ts"),
  );
  const serial = [
    "running 2 tests from ./a_test.ts",
    "shared ... FAILED (1ms)",
    "steps ...",
    "  inner ... FAILED (0ms)",
    "steps ... FAILED (due to 1 failed step) (1ms)",
    "own ... ok (1ms)",
    "running 1 test from ./b_test.ts",
    "ok ... ok (1ms)",
    "",
    " ERRORS ",
    "",
    "shared => ./helper.ts:1:6",
  ].join("\n");
  const parallel = [
    "./a_test.ts => shared ... FAILED (1ms)",
    "./a_test.ts => steps ... inner ... FAILED (0ms)",
    "./b_test.ts => ok ... ok (1ms)",
    "./a_test.ts => steps ... FAILED (due to 1 failed step) (1ms)",
  ].join("\n");
  for (const stdout of [serial, parallel]) {
    const results = summarize(run({ report, stdout, exitCode: 1 }), selections);
    const a = results.get("p/a_test.ts")!;
    assert(a.includes("helper failure") && a.includes("step failure"), a);
    assert(a.includes("registered in ./helper.ts"), a);
    assert(results.get("p/b_test.ts") === "", results.get("p/b_test.ts")!);
  }
});

Deno.test("a helper's failure stdout places in an unselected module fails every check", () => {
  const report = junit(
    pass("./a_test.ts"),
    pass("./b_test.ts"),
    fail("./helper.ts", "shared", "helper failure"),
  );
  const stdout =
    "running 1 test from ./a_test.ts\nrunning 1 test from ./b_test.ts\n" +
    "running 1 test from ./other_test.ts\nshared ... FAILED (1ms)\n";
  const results = summarize(run({ report, stdout, exitCode: 1 }), selections);
  for (const s of selections) {
    assert(
      results.get(s.key)!.includes("failures outside the selected test files"),
      results.get(s.key)!,
    );
  }
});

Deno.test("with --parallel, a module is started by its prefixed test lines", () => {
  const { started } = parseStdout("./a_test.ts => from helper ... ok (1ms)\n");
  assert(started.has("./a_test.ts"), [...started].join(","));
});
