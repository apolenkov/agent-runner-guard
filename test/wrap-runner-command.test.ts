import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { wrapRunnerCommand } from "../src/hooks/wrap-runner-command.ts";

const HOOK = fileURLToPath(
  new URL("../src/hooks/wrap-runner-command.ts", import.meta.url),
);
const WATCHDOG = fileURLToPath(new URL("../src/watchdog.ts", import.meta.url));
const PI_ALERT = fileURLToPath(
  new URL("../src/harness/pi-alert.ts", import.meta.url),
);

function bash(command: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tool_name: "Bash",
    tool_input: { command, ...extra },
    cwd: "/work/repo",
  });
}

function updatedInput(output: string): Record<string, unknown> {
  const parsed = JSON.parse(output) as {
    hookSpecificOutput: {
      hookEventName: string;
      updatedInput: Record<string, unknown>;
    };
  };
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal("permissionDecision" in parsed.hookSpecificOutput, false);
  return parsed.hookSpecificOutput.updatedInput;
}

void test("оборачивает devin -p и pi -p, сохраняя description и timeout", () => {
  for (const [command, expected, watch] of [
    [
      "devin -p 'задача' > out.txt",
      "devin -p 'задача' > out.txt",
      " --watch-file '/work/repo/out.txt'",
    ],
    ["cd /x && pi -p hi", `cd /x && pi -e '${PI_ALERT}' -p hi`, ""],
  ] as const) {
    const output = wrapRunnerCommand(
      bash(command, { description: "запуск", timeout: 600_000 }),
      WATCHDOG,
    );
    const input = updatedInput(output);
    assert.equal(
      input["command"],
      `node '${WATCHDOG}' --silence 600 --max-seconds 585${watch} -- bash -c '${expected.replaceAll("'", String.raw`'\''`)}'`,
    );
    assert.equal(input["description"], "запуск");
    assert.equal(input["timeout"], 600_000);
  }
});

void test("таймаут переднего плана → --max-seconds = таймаут − 15 с, не меньше 30", () => {
  const cases: [number, string][] = [
    [120_000, "105"],
    [600_000, "585"],
    [20_000, "30"],
    [1500, "30"],
  ];
  for (const [timeout, seconds] of cases) {
    const input = updatedInput(
      wrapRunnerCommand(bash("devin -p x", { timeout }), WATCHDOG),
    );
    assert.equal(
      input["command"],
      `node '${WATCHDOG}' --silence 600 --max-seconds ${seconds} -- bash -c 'devin -p x'`,
    );
  }
});

void test("run_in_background: потолок тоже по таймауту Bash (явный или 30 минут)", () => {
  const explicit = updatedInput(
    wrapRunnerCommand(
      bash("devin -p x", { run_in_background: true, timeout: 600_000 }),
      WATCHDOG,
    ),
  );
  assert.equal(
    explicit["command"],
    `node '${WATCHDOG}' --silence 600 --max-seconds 585 -- bash -c 'devin -p x'`,
  );
  const byDefault = updatedInput(
    wrapRunnerCommand(
      bash("devin -p x", { run_in_background: true }),
      WATCHDOG,
    ),
  );
  assert.equal(
    byDefault["command"],
    `node '${WATCHDOG}' --silence 600 --max-seconds 1785 -- bash -c 'devin -p x'`,
  );
});

void test("оборачивает codex exec и codex exec review", () => {
  for (const [command, watch] of [
    ["codex exec 'задача' > out.txt", " --watch-file '/work/repo/out.txt'"],
    ["cd /x && codex exec review 'план'", ""],
  ] as const) {
    const input = updatedInput(wrapRunnerCommand(bash(command), WATCHDOG));
    assert.equal(
      input["command"],
      `node '${WATCHDOG}' --silence 600 --max-seconds 105${watch} -- bash -c '${command.replaceAll("'", String.raw`'\''`)}'`,
      command,
    );
  }
});

void test("не трогает ls, git status, devin --version, pipe -p, codex без exec", () => {
  for (const command of [
    "ls",
    "git status",
    "devin --version",
    "pipe -p x",
    "echo happi -p",
    "codex --version",
    "codex",
    "mycodex exec x",
    "codex-foo exec x",
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
    [
      "-c",
      wrapped.replace(
        /^node \S+ --silence 600 --max-seconds 105 -- bash -c/,
        "printf %s",
      ),
    ],
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
    `node '${WATCHDOG}' --silence 600 --max-seconds 105 -- bash -c 'devin -p x'`,
  );
  const garbage = spawnSync(process.execPath, [HOOK], {
    input: "}{",
    encoding: "utf8",
  });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, "");
});

void test("путь к сторожу с пробелом и кавычкой экранируется", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wrap hook '"));
  const fake = path.join(directory, "watchdog.ts");
  await writeFile(fake, "");
  const output = JSON.parse(wrapRunnerCommand(bash("pi -p x"), fake)) as {
    hookSpecificOutput: { updatedInput: { command: string } };
  };
  assert.equal(
    output.hookSpecificOutput.updatedInput.command,
    `node '${fake.replaceAll("'", String.raw`'\''`)}' --silence 600 --max-seconds 105 -- bash -c 'pi -p x'`,
  );
  await rm(directory, { recursive: true, force: true });
});

void test("передний план без timeout: потолок по умолчанию 120 с − 15 = 105 с", () => {
  const input = updatedInput(wrapRunnerCommand(bash("devin -p x"), WATCHDOG));
  assert.equal(
    input["command"],
    `node '${WATCHDOG}' --silence 600 --max-seconds 105 -- bash -c 'devin -p x'`,
  );
});

void test("вывод исполнителя в файл → сторож следит за файлом (--watch-file)", () => {
  const plain = updatedInput(
    wrapRunnerCommand(
      bash(
        'cd /w && devin -p --prompt-file /p.md > /tmp/run.out 2>&1; echo "exit=$?" >> /tmp/run.out',
      ),
      WATCHDOG,
    ),
  );
  assert.match(String(plain["command"]), /--watch-file '\/tmp\/run\.out' /);
  const quoted = updatedInput(
    wrapRunnerCommand(bash("pi -p \"x\" >> '/a b/out.log'"), WATCHDOG),
  );
  assert.match(String(quoted["command"]), /--watch-file '\/a b\/out\.log' /);
  const none = updatedInput(
    wrapRunnerCommand(bash("devin -p x 2>&1"), WATCHDOG),
  );
  assert.doesNotMatch(String(none["command"]), /--watch-file/);
});

void test("относительный файл вывода разрешается от cd в команде или от cwd хука", () => {
  const afterCd = updatedInput(
    wrapRunnerCommand(
      bash("cd /w/tree && devin -p x > run.out 2>&1"),
      WATCHDOG,
    ),
  );
  assert.match(
    String(afterCd["command"]),
    /--watch-file '\/w\/tree\/run\.out' /,
  );
  const relativeCd = updatedInput(
    wrapRunnerCommand(bash("cd sub && pi -p x > o.log"), WATCHDOG),
  );
  assert.match(
    String(relativeCd["command"]),
    /--watch-file '\/work\/repo\/sub\/o\.log' /,
  );
  const noCwd = updatedInput(
    wrapRunnerCommand(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "devin -p x > r.out" },
      }),
      WATCHDOG,
    ),
  );
  assert.doesNotMatch(String(noCwd["command"]), /--watch-file/); // некуда разрешить — не следим
  const viaVariable = updatedInput(
    wrapRunnerCommand(bash("cd $WORK && devin -p x > r.out"), WATCHDOG),
  );
  assert.doesNotMatch(String(viaVariable["command"]), /--watch-file/);
});

function wrapped(command: string): unknown {
  return updatedInput(wrapRunnerCommand(bash(command), WATCHDOG))["command"];
}

void test("pi -p получает расширение pi-alert (-e), devin и codex — нет", () => {
  const inner = `cd /x && pi -e '${PI_ALERT}' -p hi > o.log; echo pi -p`;
  assert.ok(
    String(wrapped("cd /x && pi -p hi > o.log; echo pi -p")).endsWith(
      ` -- bash -c '${inner.replaceAll("'", String.raw`'\''`)}'`,
    ),
  );
  // текст в кавычках — не команда: промпт не меняется, инструментируется настоящий pi
  assert.doesNotMatch(
    String(wrapped("codex exec 'Explain pi -p'")),
    /pi-alert/,
  );
  assert.ok(
    String(wrapped("echo 'pi -p'; pi -p hi")).endsWith(
      String.raw` -- bash -c 'echo '\''pi -p'\''; pi -e '\''${PI_ALERT}'\'' -p hi'`,
    ),
  );
  for (const prefixed of [
    "env X=1 pi -p hi",
    "exec pi -p hi",
    "timeout 600 pi -p hi",
    "/usr/local/bin/pi -p hi",
  ]) {
    assert.match(
      String(wrapped(prefixed)),
      /pi -e '\\''[^']*pi-alert\.ts'\\'' -p hi'$/,
      prefixed,
    );
  }
  assert.doesNotMatch(String(wrapped("devin -p x")), /pi-alert/);
  assert.doesNotMatch(String(wrapped("codex exec x")), /pi-alert/);
});

void test("нет файла расширения рядом со сторожем → pi -p без -e", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wrap-no-ext-"));
  try {
    const watchdog = path.join(directory, "watchdog.ts");
    await writeFile(watchdog, "");
    const command = updatedInput(wrapRunnerCommand(bash("pi -p hi"), watchdog))[
      "command"
    ];
    assert.match(String(command), / -- bash -c 'pi -p hi'$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("pi -p внутри кавычек присваивания не трогается, инструментируется настоящий", () => {
  const command = String(wrapped('NOTE="try pi -p hi"; pi -p hi'));
  assert.ok(command.includes('NOTE="try pi -p hi"; pi -e'), command);
});
