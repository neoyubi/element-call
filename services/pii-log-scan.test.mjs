import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Service logs outlive the meetings they describe, so a name, an address or a
// join link in a log line is a disclosure. This scan is the rule stated once
// over the source; the console capture in worker.test.mjs is the same rule
// applied to real output. Reading source rather than running it means a branch
// nobody exercises is covered too.

const SERVICES = new URL(".", import.meta.url).pathname;

// State fields that name or reach a person, plus the two credential-shaped
// words. Deliberately a shape rather than a list, so a field named
// patient_email is caught without anyone remembering to extend this.
const PERSONAL = /_email\b|_name\b|meet_link|password|authorization/i;

// The deployment's own Matrix server name is configuration, not personal data,
// and the service prints it once at startup so an operator can confirm it.
const ALLOWED = new Set(["SERVER_NAME"]);

// A caught error's message is third-party controlled on these paths: an MTA
// rejection quotes the recipient it refused, and a calendar failure can quote
// the collection URL, which contains the mailbox address.
const SENSITIVE_FAILURE = /\b(calendar|caldav|smtp|mail)\b/i;

// Blank comments and literal text while keeping template substitutions, so the
// scan sees the identifiers a log line reads and not the words it prints. The
// result is the same length as the input, so offsets stay comparable.
function codeOnly(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  // One entry per open template literal. `text` distinguishes the literal part
  // from a substitution; `depth` tracks braces so the closing one is found.
  const templates = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const pair = source.slice(i, i + 2);
    const top = templates.at(-1);

    if (top?.text) {
      if (char === "\\") {
        blank(i, i + 2);
        i += 2;
      } else if (char === "`") {
        templates.pop();
        i += 1;
      } else if (pair === "${") {
        top.text = false;
        top.depth = 0;
        i += 2;
      } else {
        blank(i, i + 1);
        i += 1;
      }
      continue;
    }

    if (pair === "//" || pair === "/*") {
      const close =
        pair === "//" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2);
      const end =
        close === -1 ? source.length : close + (pair === "//" ? 0 : 2);
      blank(i, end);
      i = end;
    } else if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < source.length && source[end] !== char) {
        end += source[end] === "\\" ? 2 : 1;
      }
      blank(i + 1, Math.min(end, source.length));
      i = end + 1;
    } else if (char === "`") {
      templates.push({ text: true, depth: 0 });
      i += 1;
    } else if (top && char === "{") {
      top.depth += 1;
      i += 1;
    } else if (top && char === "}") {
      if (top.depth === 0) top.text = true;
      else top.depth -= 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

// Every console call, as { line, args, text }: args is the code-only argument
// list, text is the same span of the original source.
function consoleCalls(source) {
  const code = codeOnly(source);
  const calls = [];
  const pattern = /console\.(log|warn|error|info|debug)\(/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < code.length && depth > 0) {
      if (code[end] === "(") depth++;
      else if (code[end] === ")") depth--;
      end++;
    }
    calls.push({
      line: source.slice(0, match.index).split("\n").length,
      start,
      args: code.slice(start, end - 1),
      text: source.slice(start, end - 1),
    });
  }
  return calls;
}

// Character ranges covered by a catch block, so a failure log can be told apart
// from a success log.
function catchRanges(source) {
  const code = codeOnly(source);
  const ranges = [];
  const pattern = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < code.length && depth > 0) {
      if (code[end] === "{") depth++;
      else if (code[end] === "}") depth--;
      end++;
    }
    ranges.push([match.index, end]);
  }
  return ranges;
}

function personalDataViolations(source) {
  const found = [];
  for (const call of consoleCalls(source)) {
    for (const identifier of call.args.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (!ALLOWED.has(identifier) && PERSONAL.test(identifier)) {
        found.push(`line ${call.line}: logs ${identifier}`);
      }
    }
  }
  return found;
}

// The leading fixed words of a log line, which identify it across edits that
// move it around the file.
function logLabel(text) {
  return text
    .replace(/^[\s`]+/, "")
    .split("${")[0]
    .trim();
}

function caughtMessageViolations(source) {
  const ranges = catchRanges(source);
  return consoleCalls(source)
    .filter(
      (call) =>
        ranges.some(([from, to]) => call.start > from && call.start < to) &&
        SENSITIVE_FAILURE.test(call.text) &&
        /\.message\b/.test(call.args),
    )
    .map((call) => logLabel(call.text));
}

// Call sites that still interpolate a caught error message on a calendar path.
// Pinned as an equality rather than tolerated, so removing one without emptying
// this list fails just as loudly as adding a new one.
const PENDING_MESSAGE_LOGS = {
  "admin-api/server.mjs": ["Calendar", "Calendar cancel failed for booking"],
  "meeting-worker/worker.mjs": ["Retention: CalDAV delete failed for booking"],
};

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
      found.push(path);
    }
  }
  return found;
}

const files = sourceFiles(SERVICES);

describe("service logs", () => {
  test("there are service sources to scan", () => {
    assert.ok(files.length >= 4, `only found ${files.length} service sources`);
  });

  for (const file of files) {
    const relative = file.slice(SERVICES.length);

    test(`${relative} logs nothing that identifies a person`, () => {
      assert.deepEqual(personalDataViolations(readFileSync(file, "utf8")), []);
    });

    test(`${relative} reports mail and calendar failures by code, not message`, () => {
      assert.deepEqual(
        caughtMessageViolations(readFileSync(file, "utf8")),
        PENDING_MESSAGE_LOGS[relative] ?? [],
      );
    });
  }
});

// A scan that cannot fail proves nothing, so it is run against planted
// violations and against the shapes it must not mistake for one.
describe("the scan itself", () => {
  test("catches a personal field read into a log line", () => {
    assert.deepEqual(
      personalDataViolations(
        "console.warn(`booking ${meeting.prospect_email} failed`);",
      ),
      ["line 1: logs prospect_email"],
    );
  });

  test("catches a join link and a credential", () => {
    assert.equal(
      personalDataViolations("console.log(meeting.meet_link, config.password);")
        .length,
      2,
    );
  });

  test("catches a caught error message on the calendar path", () => {
    assert.deepEqual(
      caughtMessageViolations(
        "try { a(); } catch (err) { console.warn(`Calendar write failed: ${err.message}`); }",
      ),
      ["Calendar write failed:"],
    );
  });

  test("allows the words a log line prints, only the values it reads matter", () => {
    assert.deepEqual(
      personalDataViolations(
        "console.warn(`Failed to persist meet_link for booking ${bookingId}`);",
      ),
      [],
    );
  });

  test("allows an error code on the mail path", () => {
    assert.deepEqual(
      caughtMessageViolations(
        "try { a(); } catch (err) { console.warn(`SMTP send failed: ${err.code}`); }",
      ),
      [],
    );
  });

  test("allows an error message on a path that is neither mail nor calendar", () => {
    assert.deepEqual(
      caughtMessageViolations(
        "try { a(); } catch (err) { console.warn(`Emails: read failed: ${err.message}`); }",
      ),
      [],
    );
  });

  test("is not confused by a URL inside a string or a nested template", () => {
    assert.deepEqual(
      personalDataViolations(
        'const a = "http://example.com/*"; console.log(`${`x ${y}`}`);',
      ),
      [],
    );
  });
});
