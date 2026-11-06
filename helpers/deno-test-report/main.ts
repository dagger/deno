// deno-test-report reads one `deno test` run once -- its JUnit report, its
// pretty stdout and its stderr -- and writes a bounded result for each
// selected test file: an empty file when the file passed, otherwise why it
// failed. Every test-file check of a project reads only its own result.
//
// It has no imports, so it runs with `deno run --no-remote` from a pinned image.

/** Diagnostics keep the last 32 KiB of each stream. */
export const diagnosticLimit = 32 << 10;

/** One selected test file: its check's key and the path deno reports it as. */
export interface Selection {
  key: string;
  file: string;
}

export interface Run {
  /** The JUnit XML, or null when deno wrote none. */
  report: string | null;
  stdout: string;
  stderr: string;
  exitCode: number;
  failFast: boolean;
}

interface TestCase {
  name: string;
  file: string;
  failure: string | null;
}

/** The last `limit` bytes of `text`, marked when anything was dropped. */
export function tail(text: string, limit = diagnosticLimit): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  const kept = new TextDecoder().decode(bytes.slice(bytes.length - limit));
  return "[earlier output omitted; showing diagnostic tail]\n" + kept;
}

function cap(text: string): string {
  const limit = 3 * diagnosticLimit;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  return new TextDecoder().decode(bytes.slice(0, limit)) +
    "\n[remaining diagnostics omitted]\n";
}

function unescapeXml(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g,
    (_, entity: string) => {
      switch (entity) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "amp":
          return "&";
        case "quot":
          return '"';
        case "apos":
          return "'";
      }
      const code = entity.startsWith("#x")
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    },
  );
}

function attribute(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
}

/**
 * The test cases in deno's JUnit report. deno escapes every text node, so a
 * scan for its elements cannot be fooled by test output. Steps are reported as
 * test cases of their own ("parent > step"), which is fine at file granularity.
 */
export function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = m[1];
    const body = m[3] ?? "";
    const failure = body.match(
      /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/,
    );
    let message: string | null = null;
    if (failure) {
      const text = unescapeXml(failure[4] ?? "");
      message = text !== ""
        ? text
        : (attribute(failure[2], "message") ?? "failed");
    }
    cases.push({
      name: attribute(attrs, "name") ?? "",
      file: attribute(attrs, "classname") ?? "",
      failure: message,
    });
  }
  return cases;
}

/** Strip ANSI colors, in case NO_COLOR was not honored. */
function plain(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * What the pretty reporter's stdout says about the test modules deno ran,
 * which the JUnit report does not: the ones it started ("running N tests from
 * ./x_test.ts", printed even for N = 0, or with --parallel a "./x_test.ts =>"
 * prefix on each test), the ones that threw outside any test ("Uncaught error
 * from ./x_test.ts FAILED", details in ERRORS), and which module ran each
 * failing top-level test. JUnit names the file that registered a test, so a
 * test an imported helper registers is reported there; stdout names the test
 * module that imported it.
 */
export function parseStdout(
  stdout: string,
): {
  started: Set<string>;
  uncaught: Map<string, string>;
  failedIn: Map<string, Set<string>>;
} {
  const lines = plain(stdout).split("\n");
  const started = new Set<string>();
  const uncaught = new Map<string, string>();
  const failedIn = new Map<string, Set<string>>();
  const fail = (name: string, module: string) =>
    failedIn.set(name, (failedIn.get(name) ?? new Set()).add(module));
  let current: string | null = null;
  for (const line of lines) {
    const run = line.match(/^running \d+ tests? from (.+)$/);
    if (run) {
      current = run[1].trim();
      started.add(current);
      continue;
    }
    const err = line.match(/^Uncaught error from (.+) FAILED$/);
    if (err) uncaught.set(err[1].trim(), "");
    if (line.trim() === "ERRORS") current = null;
    // --parallel: "./x_test.ts => name ... ok"; steps continue the name with
    // " ... step", so the shortest name before " ... " is the test's own.
    const parallel = line.match(
      /^(\.\/\S+|[a-z]+:\/\/\S+) => (.+?) \.\.\. (.*)$/,
    );
    if (parallel) {
      started.add(parallel[1]);
      if (/\bFAILED\b/.test(parallel[3])) fail(parallel[2], parallel[1]);
      continue;
    }
    // Serial: unindented "name ... FAILED" under the module's header. Steps
    // are indented.
    const serial = line.match(/^(\S.*?) \.\.\. FAILED\b/);
    if (serial && current !== null) fail(serial[1], current);
  }
  // The details are the ERRORS block headed "<file> (uncaught error)".
  for (const file of uncaught.keys()) {
    const start = lines.indexOf(file + " (uncaught error)");
    if (start < 0) continue;
    const block: string[] = [];
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (
        i > start &&
        (line.trim() === "FAILURES" || line.endsWith(" (uncaught error)") ||
          / => \S+:\d+:\d+$/.test(line))
      ) {
        break;
      }
      block.push(line);
    }
    uncaught.set(file, block.join("\n").trimEnd());
  }
  return { started, uncaught, failedIn };
}

/** The result for each selected file, by key: "" passes. */
export function summarize(
  run: Run,
  selections: Selection[],
): Map<string, string> {
  const selected = new Map<string, Selection>();
  for (const s of selections) {
    if (s.key === "" || s.file === "") {
      throw new Error(`invalid selection ${JSON.stringify(s)}`);
    }
    if (selected.has(s.file)) {
      throw new Error(`duplicate selected file ${s.file}`);
    }
    selected.set(s.file, s);
  }
  const diagnostics = tail(plain(run.stdout)) + "\n" + tail(plain(run.stderr));
  const results = new Map<string, string>();
  const failAll = (why: string) => {
    for (const s of selections) results.set(s.key, cap(why));
    return results;
  };

  if (run.report === null) {
    // deno stops before running any test when type-checking or loading the
    // modules fails, or when a flag is wrong: no file can be told apart.
    return failAll(
      `deno test failed before reporting any test (exit ${run.exitCode})\n${diagnostics}`,
    );
  }
  const cases = parseJUnit(run.report);
  const { started, uncaught, failedIn } = parseStdout(run.stdout);

  const failed = new Map<string, TestCase[]>();
  const reported = new Set<string>();
  const add = (file: string, c: TestCase) =>
    failed.set(file, [...(failed.get(file) ?? []), c]);
  for (const c of cases) {
    reported.add(c.file);
    if (c.failure === null) continue;
    if (selected.has(c.file)) {
      add(c.file, c);
      continue;
    }
    // Registered outside the selected files, by an imported helper: blame the
    // test modules stdout says ran it failing, when every one is selected. A
    // step ("test > step") is found by its top-level test.
    const modules = failedIn.get(c.name) ??
      failedIn.get(c.name.split(" > ")[0]);
    if (modules && [...modules].every((m) => selected.has(m))) {
      const name = `${c.name} (registered in ${c.file})`;
      for (const m of modules) {
        // JUnit lists the helper's test once per module that ran it.
        if (!(failed.get(m) ?? []).some((o) => o.name === name)) {
          add(m, { ...c, name });
        }
      }
    } else {
      add(c.file, c);
    }
  }

  // A failure deno attributes to no selected file -- a doc test, a test file
  // discovery did not list, a helper's test stdout cannot place -- cannot be
  // pinned on one check, so it fails every check sharing the run.
  const outside = [...new Set([...failed.keys(), ...uncaught.keys()])].filter((
    f,
  ) => !selected.has(f)).sort();
  if (outside.length > 0) {
    const detail = outside.map((f) =>
      (failed.get(f) ?? []).map((c) => `${c.name} (${f})\n${c.failure}`).join(
        "\n",
      ) +
      (uncaught.has(f) ? `${f} (uncaught error)\n${uncaught.get(f)}` : "")
    ).join("\n");
    return failAll(
      `failures outside the selected test files: ${outside.join(", ")}\n${
        tail(detail)
      }\n${diagnostics}`,
    );
  }

  const attributed = failed.size > 0 || uncaught.size > 0;
  if (
    run.exitCode !== 0 && !attributed &&
    selections.every((s) => reported.has(s.file) || started.has(s.file))
  ) {
    return failAll(
      `shared test command failed (deno test exit ${run.exitCode})\n${diagnostics}`,
    );
  }

  for (const s of selections) {
    const own = failed.get(s.file) ?? [];
    let result = "";
    if (uncaught.has(s.file)) {
      result = `${s.file} threw outside a test\n${
        uncaught.get(s.file) || diagnostics
      }`;
      if (own.length > 0) {
        result += "\n" +
          own.map((c) => `${c.name} failed\n${c.failure}`).join("\n");
      }
    } else if (own.length > 0) {
      result = own.map((c) => `${c.name} failed\n${tail(c.failure ?? "")}`)
        .join("\n");
    } else if (reported.has(s.file) || started.has(s.file)) {
      // Passed.
    } else if (run.exitCode === 0) {
      // deno left the file out: a config `exclude`, an `--ignore` in testArgs.
      result =
        `${s.file} did not run: deno test passed without it\n${diagnostics}`;
    } else if (run.failFast && attributed) {
      // --fail-fast stopped the run at a reported failure before this file
      // started. That failure is not this file's.
    } else {
      result =
        `no result for ${s.file} (deno test exit ${run.exitCode})\n${diagnostics}`;
    }
    results.set(s.key, cap(result));
  }
  return results;
}

function flag(args: string[], name: string): string {
  const i = args.indexOf("--" + name);
  if (i < 0 || i + 1 >= args.length) throw new Error(`missing --${name}`);
  return args[i + 1];
}

function readOrNull(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

if (import.meta.main) {
  const args = Deno.args;
  const selections: Selection[] = JSON.parse(
    Deno.readTextFileSync(flag(args, "selection")),
  );
  const results = summarize({
    report: readOrNull(flag(args, "report")),
    stdout: readOrNull(flag(args, "stdout")) ?? "",
    stderr: readOrNull(flag(args, "stderr")) ?? "",
    exitCode: parseInt(flag(args, "exit-code"), 10),
    failFast: flag(args, "fail-fast") === "true",
  }, selections);
  // Results are named by the file's rank in the selection, which the module
  // sorts by key before encoding it, so paths never become file names.
  const output = flag(args, "output");
  Deno.mkdirSync(output, { recursive: true });
  selections.forEach((s, i) =>
    Deno.writeTextFileSync(`${output}/${i}`, results.get(s.key) ?? "")
  );
}
