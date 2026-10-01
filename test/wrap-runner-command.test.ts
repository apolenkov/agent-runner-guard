import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { wrapRunnerCommand } from "../src/hooks/wrap-runner-command.ts";

const HOOK = fileURLToPath(
  new URL("../src/hooks/wrap-runner-command.ts", import.meta.url),
);
const WATCHDOG = fileURLToPath(new URL("../src/watchdog.ts", import.meta.url));

function bash(command: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tool_name: "Bash",
    tool_input: { command, ...extra },
  });
}

function updatedInput(output: string): Record<string, unknown> {
  const parsed = JSON.parse(output) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      updatedInput: Record<string, unknown>;
    };
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
  return parsed.hookSpecificOutput.updatedInput;
}

void test("оборачивает devin -p и pi -p, сохраняя description и timeout", () => {
  for (const command of ["devin -p 'задача' > out.txt", "cd /x && pi -p hi"]) {
    const output = wrapRunnerCommand(
      bash(command, { description: "запуск", timeout: 600_000 }),
      WATCHDOG,
    );
    const input = updatedInput(output);
    assert.equal(
      input["command"],
      `node ${WATCHDOG} --silence 600 -- bash -c '${command.replaceAll("'", String.raw`'\''`)}'`,
    );
    assert.equal(input["description"], "запуск");
    assert.equal(input["timeout"], 600_000);
  }
});

void test("не трогает ls, git status, devin --version, pipe -p", () => {
  for (const command of [
    "ls",
    "git status",
    "devin --version",
    "pipe -p x",
    "echo happi -p",
  ]) {
    assert.equal(wrapRunnerCommand(bash(command), WATCHDOG), "", command);
  }
});

void test("экранирование: одинарные кавычки, $, ;, && переживают bash -c", () => {
  const command = `devin -p 'it'"'"'s $HOME; echo a && echo "b"' > /dev/null`;
  const input = updatedInput(wrapRunnerCommand(bash(command), WATCHDOG));
  const wrapped = String(input["command"]);
  // Настоящий разбор bash: печатаем аргумент -c через подставной node.
  const result = spawnSync(
    "bash",
    ["-c", wrapped.replace(/^node \S+ --silence 600 -- bash -c/, "printf %s")],
    { encoding: "utf8" },
  );
  assert.equal(result.stdout, command);
});

void test("не Bash, мусор, пустой ввод, нет файла сторожа → пустой вывод", () => {
  assert.equal(
    wrapRunnerCommand(
      JSON.stringify({
        tool_name: "Read",
        tool_input: { command: "devin -p" },
      }),
      WATCHDOG,
    ),
    "",
  );
  assert.equal(wrapRunnerCommand("не json", WATCHDOG), "");
  assert.equal(wrapRunnerCommand("", WATCHDOG), "");
  assert.equal(wrapRunnerCommand("null", WATCHDOG), "");
  assert.equal(
    wrapRunnerCommand(bash("devin -p x"), "/нет/такого/watchdog.ts"),
    "",
  );
  assert.equal(
    wrapRunnerCommand(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: 5 } }),
      WATCHDOG,
    ),
    "",
  );
});

void test("как скрипт: JSON на входе → JSON на выходе, мусор → пусто, код 0", () => {
  const wrapped = spawnSync(process.execPath, [HOOK], {
    input: bash("devin -p x"),
    encoding: "utf8",
  });
  assert.equal(wrapped.status, 0);
  assert.equal(
    updatedInput(wrapped.stdout)["command"],
    `node ${WATCHDOG} --silence 600 -- bash -c 'devin -p x'`,
  );
  const garbage = spawnSync(process.execPath, [HOOK], {
    input: "}{",
    encoding: "utf8",
  });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, "");
});
