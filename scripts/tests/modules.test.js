import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The entry point scripts run their work on import, so they cannot simply be
// imported here. Parsing them in a child process catches a broken file that
// nothing else in the suite would ever load.
test("every script parses", async () => {
  const entries = await readdir(scriptsDirectory, { withFileTypes: true });
  const scriptFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(scriptsDirectory, entry.name));

  assert.ok(scriptFiles.length > 5, "found the scripts directory");

  for (const scriptFile of scriptFiles) {
    const child = execFileAsync(process.execPath, ["--input-type=module", "--check"]);
    child.child.stdin.end(await readFile(scriptFile));

    await assert.doesNotReject(child, `${scriptFile} parses`);
  }
});
