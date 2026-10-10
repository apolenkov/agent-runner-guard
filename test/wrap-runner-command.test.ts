import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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

void test("hook timeout: public CLI bounds ceilings and preserves fallback controls", async (t) => {
  const cases: [string, Record<string, unknown>, number | undefined][] = [
    ["short Pi", { timeout: 1500 }, undefined],
    ["below reserve", { timeout: 14_999 }, undefined],
    ["reserve", { timeout: 15_000 }, undefined],
    ["just above reserve", { timeout: 15_001 }, undefined],
    ["fraction below second", { timeout: 15_999 }, undefined],
    ["first second", { timeout: 16_000 }, 1],
    ["fraction floors down", { timeout: 16_999 }, 1],
    ["five seconds", { timeout: 20_000 }, 5],
    ["explicit foreground", { timeout: 120_000 }, 105],
    ["explicit long", { timeout: 600_000 }, 585],
    ["foreground default", {}, 105],
    ["background default", { run_in_background: true }, 1785],
    ["background short", { run_in_background: true, timeout: 1500 }, undefined],
    ["background explicit", { run_in_background: true, timeout: 20_000 }, 5],
    ["false background", { run_in_background: false }, 105],
    ["nonboolean background", { run_in_background: "true" }, 105],
    ["zero fallback", { timeout: 0 }, 105],
    ["negative fallback", { timeout: -1 }, 105],
    ["string fallback", { timeout: "1500" }, 105],
    ["null fallback", { timeout: null }, 105],
    ["false fallback", { timeout: false }, 105],
  ];
  for (const [name, extra, seconds] of cases) {
    await t.test(name, () => {
      const original = {
        command: "pi -p x",
        description: "timeout owner",
        marker: { keep: true },
        ...extra,
      };
      const result = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: original,
          cwd: "/work/repo",
        }),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      if (seconds === undefined) assert.equal(result.stdout, "");
      else {
        const returned = updatedInput(result.stdout);
        const { command: returnedCommand, ...returnedFields } = returned;
        const { command: _originalCommand, ...originalFields } = original;
        assert.deepEqual(returnedFields, originalFields);
        const inner = `pi -e '${PI_ALERT}' -p x`;
        assert.equal(
          returnedCommand,
          `node '${WATCHDOG}' --silence 600 --max-seconds ${String(seconds)} -- bash -c '${inner.replaceAll("'", String.raw`'\''`)}'`,
        );
      }
    });
  }
  await t.test("positive nonfinite numeric JSON fails open", () => {
    const result = spawnSync(process.execPath, [HOOK], {
      input:
        '{"tool_name":"Bash","tool_input":{"command":"pi -p x","timeout":1e309}}',
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "");
  });
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

async function fixtureRecord<T>(file: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`owned fixture record missing: ${file}`);
}

function stopFixtureGroup(
  pgid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (pgid === undefined) return;
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

void test("hook timeout: actual returned command under a synthetic outer deadline", async (t) => {
  for (const timeout of [1500, 20_000]) {
    await t.test(`${String(timeout)}ms synthetic outer tool`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "hook-deadline-"));
      type OwnedFixture = { pid: number; pgid: number; descendant?: number };
      let owned: OwnedFixture | undefined;
      const pi = path.join(directory, "pi");
      const descendant = path.join(directory, "descendant.cjs");
      await writeFile(
        descendant,
        `
const fs = require("node:fs");
const directory = process.argv[2];
process.on("SIGTERM", () => {
  fs.writeFileSync(directory + "/descendant-stop.json", JSON.stringify({ pid: process.pid, signalled: Date.now() }));
  process.exit(0);
});
fs.writeFileSync(directory + "/descendant-ready.json", JSON.stringify({ pid: process.pid, ready: Date.now() }));
setInterval(() => {}, 1000);
`,
      );
      await writeFile(
        pi,
        `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const directory = process.argv.at(-1);
const pgid = Number(cp.execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
const owned = { pid: process.pid, pgid, argv: process.argv.slice(2) };
fs.writeFileSync(directory + "/owned.json", JSON.stringify(owned));
const child = cp.spawn(process.execPath, [directory + "/descendant.cjs", directory], { stdio: "inherit" });
owned.descendant = child.pid;
fs.writeFileSync(directory + "/owned.json", JSON.stringify(owned));
process.on("SIGTERM", () => {
  fs.writeFileSync(directory + "/runner-stop.json", JSON.stringify({ pid: process.pid, signalled: Date.now() }));
  if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
  else child.once("close", () => process.exit(0));
});
const poll = setInterval(() => {
  if (!fs.existsSync(directory + "/release")) return;
  clearInterval(poll);
  fs.writeFileSync(directory + "/released.json", JSON.stringify({ released: Date.now() }));
}, 10);
setInterval(() => {}, 1000);
`,
      );
      await chmod(pi, 0o755);
      const original = {
        command: `'${pi}' -p '${directory}'`,
        timeout,
        description: "synthetic deadline",
      };
      const hook = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: original,
          cwd: directory,
        }),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(hook.error, undefined);
      assert.equal(hook.status, 0, hook.stderr);
      assert.equal(hook.stderr, "");
      const returned =
        hook.stdout === "" ? original : updatedInput(hook.stdout);
      const neighbour = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
      );
      const neighbourClosed = new Promise<void>((resolve) => {
        neighbour.on("close", resolve);
      });
      const launched = Date.now();
      const child = spawn("bash", ["-c", String(returned["command"])], {
        cwd: directory,
        detached: true,
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          EXECUTOR_LIMITS_DIR: path.join(directory, "limits"),
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => {
          resolve({ code, signal });
        });
      });
      let outerCut: number | undefined;
      let force: ReturnType<typeof setTimeout> | undefined;
      const outer = setTimeout(() => {
        outerCut = Date.now();
        // This synthetic outer tool owns both exact groups, even for fail-open calls.
        stopFixtureGroup(owned?.pgid, "SIGTERM");
        stopFixtureGroup(child.pid, "SIGTERM");
        force = setTimeout(() => {
          stopFixtureGroup(owned?.pgid, "SIGKILL");
          stopFixtureGroup(child.pid, "SIGKILL");
        }, 2000);
      }, timeout);
      try {
        owned = await fixtureRecord<OwnedFixture>(
          path.join(directory, "owned.json"),
        );
        const ready = await fixtureRecord<{ pid: number; ready: number }>(
          path.join(directory, "descendant-ready.json"),
        );
        owned = await fixtureRecord<OwnedFixture>(
          path.join(directory, "owned.json"),
        );
        // Both owned processes are running before the harmless work barrier opens.
        assert.equal(ready.pid, owned.descendant);
        process.kill(owned.pid, 0);
        process.kill(ready.pid, 0);
        await writeFile(path.join(directory, "release"), "go\n");
        const released = await fixtureRecord<{ released: number }>(
          path.join(directory, "released.json"),
        );
        const result = await closed;
        const finished = Date.now();
        const runnerStop = await fixtureRecord<{
          pid: number;
          signalled: number;
        }>(path.join(directory, "runner-stop.json"));
        const descendantStop = await fixtureRecord<{
          pid: number;
          signalled: number;
        }>(path.join(directory, "descendant-stop.json"));
        t.diagnostic(
          JSON.stringify({
            timeout,
            launched,
            ready,
            released,
            runnerStop,
            descendantStop,
            finished,
            outerCut,
            result,
            stdout,
            stderr,
            owned,
          }),
        );
        assert.equal(neighbour.exitCode, null);
        assert.equal(neighbour.signalCode, null);
        assert.ok(neighbour.pid !== undefined);
        process.kill(neighbour.pid, 0);
        assert.equal(runnerStop.pid, owned.pid);
        assert.equal(descendantStop.pid, ready.pid);
        assert.ok(runnerStop.signalled >= released.released);
        assert.ok(descendantStop.signalled >= released.released);
        assert.equal(stderr, "");
        if (timeout === 1500) {
          assert.equal(
            hook.stdout,
            "",
            "insufficient budget must leave Pi untouched",
          );
          assert.ok(
            outerCut !== undefined,
            "synthetic outer tool must own the unwrapped timeout",
          );
          assert.doesNotMatch(stdout, /WATCHDOG:|STALLED|DONE|FAILED|WAITING/);
        } else {
          assert.equal(
            outerCut,
            undefined,
            "guard must finish before this synthetic outer deadline",
          );
          assert.equal(result.code, 76, stdout);
          assert.equal(result.signal, null);
          assert.match(stdout, /STALLED ceiling\n$/);
          assert.ok(finished < launched + timeout);
        }
      } finally {
        clearTimeout(outer);
        clearTimeout(force);
        // Recover the exact owned identity even if readiness/assertions failed.
        try {
          owned = JSON.parse(
            await readFile(path.join(directory, "owned.json"), "utf8"),
          ) as typeof owned;
        } catch {
          /* no owned runner was recorded */
        }
        stopFixtureGroup(owned?.pgid, "SIGKILL");
        stopFixtureGroup(child.pid, "SIGKILL");
        await closed;
        neighbour.kill("SIGTERM");
        await neighbourClosed;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
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

void test("heredoc в команде — расширение не добавляется (тело heredoc не трогаем)", () => {
  const command = "cat > p.txt <<'EOF'\npi -p hi\nEOF\npi -p @p.txt";
  assert.doesNotMatch(String(wrapped(command)), /pi-alert/);
});

void test("<< где угодно (даже в промпте) — консервативно без расширения", () => {
  assert.doesNotMatch(String(wrapped("pi -p 'explain x << 2'")), /pi-alert/);
  assert.doesNotMatch(
    String(wrapped("# don't\ncat <<'EOF'\nHere's pi -p hi\nEOF\npi -p @p")),
    /pi-alert/,
  );
});

void test("command grammar: public hook handles Codex global flags and foreign literal controls", async (t) => {
  const positive = new Set([
    "env X=1 pi -p hi",
    "env -- pi -p hi",
    "env -- X=1 pi -p hi",
    "env -i -- X=1 pi -p hi",
    "codex -m synthetic-model exec x",
    "codex --model=synthetic-model exec x",
    "codex -c 'model=synthetic-model' --enable synthetic-feature exec x",
    "codex -C '/work/a b' --sandbox read-only --search exec x",
  ]);
  const negative = [
    '"X=1" pi -p x',
    'nohup "X=1" pi -p x',
    `printf '%s' '{"cmd":"pi -p"}'`,
    `echo 'devin -p hi; codex exec x'`,
    "codex -m exec login",
    "codex -m --help exec x",
    "codex --help exec x",
    "codex --version exec x",
    "codex --unknown exec x",
    '"$RUNNER" -p x',
    "echo $(pi -p x)",
    "f() { pi -p x; }",
    "for x in a; do pi -p x; done",
  ];
  for (const command of [...positive, ...negative]) {
    await t.test(command, () => {
      const result = spawnSync(process.execPath, [HOOK], {
        input: bash(command),
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined, command);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "", command);
      if (positive.has(command)) {
        assert.notEqual(result.stdout, "", command);
        const returned = String(updatedInput(result.stdout)["command"]);
        assert.match(returned, / -- bash -c /, command);
        if (command.startsWith("env ")) {
          const instrumented = command.replace(
            "pi -p hi",
            () => `pi -e '${PI_ALERT}' -p hi`,
          );
          assert.equal(
            returned,
            `node '${WATCHDOG}' --silence 600 --max-seconds 105 -- bash -c '${instrumented.replaceAll("'", String.raw`'\''`)}'`,
            command,
          );
        }
      } else assert.equal(result.stdout, "", command);
    });
  }
  await t.test("real Pi position after foreign JSON preserves bytes", () => {
    const command = `printf '%s' '{"cmd":"pi -p"}'; pi -p 'quoted > data'`;
    const result = spawnSync(process.execPath, [HOOK], {
      input: bash(command),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const expected = `printf '%s' '{"cmd":"pi -p"}'; pi -e '${PI_ALERT}' -p 'quoted > data'`;
    assert.equal(
      updatedInput(result.stdout)["command"],
      `node '${WATCHDOG}' --silence 600 --max-seconds 105 -- bash -c '${expected.replaceAll("'", String.raw`'\''`)}'`,
    );
  });
});

void test("command grammar: public hook observes real redirected refusal after quoted data and ordered cd", async (t) => {
  for (const kind of [
    "quoted redirect",
    "ordered relative cd",
    "subshell inherited redirect",
    "subshell inner cd",
    "subshell local redirect",
  ]) {
    await t.test(kind, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "hook-grammar-"));
      try {
        const fake = path.join(directory, "devin");
        const rejection =
          "warning: rejected a tool call that requires confirmation. Running in non-interactive mode";
        await writeFile(
          fake,
          `#!/bin/sh\nprintf '%s\\n' '${rejection}'\nsleep 3\n`,
        );
        await chmod(fake, 0o755);
        await mkdir(path.join(directory, "first", "second"), {
          recursive: true,
        });
        const prefix =
          kind === "ordered relative cd" ? "cd first && cd second && " : "";
        const prompt =
          kind === "quoted redirect" ? "task > quoted.md" : "task.md";
        const runner = `${fake} -p --prompt-file '${prompt}'`;
        const subshellCommands: Record<string, string> = {
          "subshell inherited redirect": `(${runner}) > real.out 2>&1`,
          "subshell inner cd": `(cd first && ${runner}) > real.out 2>&1`,
          "subshell local redirect": `(cd first && ${runner} > real.out 2>&1) > outer.out`,
        };
        const command =
          subshellCommands[kind] ?? `${prefix}${runner} > real.out 2>&1`;
        const event = JSON.stringify({
          tool_name: "Bash",
          tool_input: { command, timeout: 20_000 },
          cwd: directory,
        });
        const hook = spawnSync(process.execPath, [HOOK], {
          input: event,
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(hook.error, undefined);
        assert.equal(hook.status, 0, hook.stderr);
        const outputFile = path.join(
          directory,
          ...(kind === "ordered relative cd" ? ["first", "second"] : []),
          ...(kind === "subshell local redirect" ? ["first"] : []),
          "real.out",
        );
        const returned = String(updatedInput(hook.stdout)["command"]);
        const execution = spawnSync("bash", ["-c", returned], {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
            EXECUTOR_LIMITS_DIR: path.join(directory, "limits"),
          },
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(execution.error, undefined);
        assert.equal(execution.status, 78, execution.stdout + execution.stderr);
        assert.match(execution.stdout, /WATCHDOG: событие: waiting:/);
        assert.match(
          execution.stdout,
          /WAITING warning: rejected a tool call.*\n$/,
        );
        assert.doesNotMatch(execution.stdout, /STALLED|остановлен: потолок/);
        assert.equal(execution.stderr, "");
        assert.equal(await readFile(outputFile, "utf8"), `${rejection}\n`);
        if (kind === "subshell local redirect")
          assert.equal(
            await readFile(path.join(directory, "outer.out"), "utf8"),
            "",
          );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

void test("command grammar: public hook keeps unknown cd scope unresolved", async (t) => {
  for (const [script, cdPath] of [
    ["cd - && devin -p x > relative.out", ""],
    ["eval 'cd /elsewhere'; devin -p x > relative.out", ""],
    ["cd sub && devin -p x > relative.out", "/synthetic/search"],
  ]) {
    await t.test(script, () => {
      const result = spawnSync(process.execPath, [HOOK], {
        input: bash(script ?? ""),
        env: { ...process.env, CDPATH: cdPath ?? "" },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const command = String(updatedInput(result.stdout)["command"]);
      assert.match(command, / -- bash -c /);
      assert.doesNotMatch(command, /--watch-file/);
    });
  }
});
