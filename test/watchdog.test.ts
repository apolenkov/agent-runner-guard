import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { listProcesses } from "../src/proc.ts";
import {
  acquireLock,
  detectExecutor,
  findRateLimit,
  liveEvent,
  parseWatchdogArguments,
  runLockFile,
  writeLimitFile,
} from "../src/watchdog.ts";

const WATCHDOG = fileURLToPath(new URL("../src/watchdog.ts", import.meta.url));

const home = await mkdtemp(path.join(tmpdir(), "watchdog-home-"));
const bin = path.join(home, "bin");
await mkdir(bin);
// синтетический devin: скипает -p и --prompt-file <путь>, остальное — через sh
const devinScript = path.join(bin, "devin");
await writeFile(
  devinScript,
  '#!/bin/sh\nwhile :; do case "$1" in -p) shift;; --prompt-file) shift 2;; *) break;; esac; done\nexec /bin/sh "$@"\n',
);
await chmod(devinScript, 0o755);
await symlink("/bin/sh", path.join(bin, "pi"));
// синтетический codex: сбрасывает подкоманду exec и шьёт остальное через sh
const codexScript = path.join(bin, "codex");
await writeFile(
  codexScript,
  '#!/bin/sh\n[ "$1" = "exec" ] && shift\nexec /bin/sh "$@"\n',
);
await chmod(codexScript, 0o755);

after(async () => {
  await rm(home, { recursive: true, force: true });
});

interface Result {
  stdout: string;
  stderr: string;
  code: number | null;
  lastLine: string;
  seconds: number;
}

/**
 * Запуск сторожа как отдельного процесса с HOME во временном каталоге.
 */
function watchdog(
  arguments_: string[],
  homeDirectory = home,
  environment: Record<string, string> = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [WATCHDOG, ...arguments_], {
      env: { ...process.env, HOME: homeDirectory, ...environment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const lines = stdout.trimEnd().split("\n");
      resolve({
        stdout,
        stderr,
        code,
        lastLine: lines.at(-1) ?? "",
        seconds: (Date.now() - started) / 1000,
      });
    });
  });
}

async function aliveCommands(marker: string): Promise<string[]> {
  const list = await listProcesses();
  return list
    .filter((p) => p.command.includes(marker) && !p.stat?.startsWith("Z"))
    .map((p) => p.command);
}

/**
 * PID пишет сама синтетическая оболочка до запуска потомков.
 * Файл лежит в уникальном временном каталоге теста.
 */
function recordGroup(script: string, directory: string): string {
  return `echo $$ >> '${path.join(directory, "group.pid")}'; ${script}`;
}

async function killRecorded(
  directory: string,
  name = "group.pid",
): Promise<void> {
  let records: string;
  try {
    records = await readFile(path.join(directory, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  for (const line of records.trim().split("\n")) {
    const pid = Number(line);
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("неверный pid теста");
    try {
      process.kill(name === "group.pid" ? -pid : pid, "SIGKILL");
    } catch (error) {
      // ESRCH — уже нет; EPERM — на macOS так отвечает группа из одних зомби:
      // живых процессов теста там нет
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw error;
    }
  }
}

void test("чистка: сигналы только PID, записанным собственным потомком", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-owned-"));
  const signals: number[] = [];
  t.mock.method(process, "kill", (pid: number) => {
    signals.push(pid);
    return true;
  });
  try {
    await killRecorded(directory);
    assert.deepEqual(signals, []);
    await writeFile(path.join(directory, "group.pid"), "12345\n12347\n");
    await writeFile(path.join(directory, "escaped.pid"), "12346");
    await killRecorded(directory);
    await killRecorded(directory, "escaped.pid");
    assert.deepEqual(signals, [-12_345, -12_347, 12_346]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("DONE: короткая команда при медленной записи замка завершается за 3 с", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-short-"));
  const preload = path.join(directory, "slow-lock.mjs");
  await writeFile(
    preload,
    `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.writeFile;
    fs.writeFile = async (...args) => {
      if (String(args[0]).includes(".tmp-")) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return original(...args);
    };
    syncBuiltinESMExports();
  `,
  );
  try {
    const result = await watchdog(
      ["--max-seconds", "1", "--", "sh", "-c", "true"],
      directory,
      {
        NODE_OPTIONS: `--import=${preload}`,
      },
    );
    assert.equal(result.lastLine, "DONE 0");
    assert.equal(result.code, 0);
    assert.ok(result.seconds <= 3, `заняло ${String(result.seconds)} с`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("DONE: команда завершилась сама — код команды, вывод проброшен", async () => {
  const result = await watchdog(["--", "sh", "-c", "echo ok; exit 3"]);
  assert.equal(result.code, 3);
  assert.equal(result.lastLine, "DONE 3");
  assert.match(result.stdout, /^ok$/m);
});

void test("DONE: вывод без перевода строки — итог всё равно отдельной строкой", async () => {
  const result = await watchdog(["--", "sh", "-c", "printf abc"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "abc\nDONE 0\n");
});

void test("DONE: код команды 75 или 76 → выход 1, в строке настоящий код", async () => {
  for (const real of [75, 76]) {
    const result = await watchdog(["--", "sh", "-c", `exit ${String(real)}`]);
    assert.equal(result.code, 1);
    assert.equal(result.lastLine, `DONE ${String(real)}`);
  }
});

void test("STALLED silence: тишина → 76, процесс и потомок убиты, соседний жив", async () => {
  const neighbour = spawn("sleep", ["597.31"]);
  try {
    const result = await watchdog([
      "--silence",
      "2",
      "--",
      "sh",
      "-c",
      "sleep 599.17; true",
    ]);
    assert.equal(result.code, 76);
    assert.equal(result.lastLine, "STALLED silence");
    assert.match(result.stdout, /WATCHDOG: остановлен: тишина \d+ с/);
    assert.ok(result.seconds <= 8, `заняло ${String(result.seconds)} с`);
    assert.deepEqual(await aliveCommands("sleep 599.17"), []);
    const neighbours = await aliveCommands("sleep 597.31");
    assert.equal(neighbours.length, 1);
  } finally {
    neighbour.kill();
  }
});

void test("фоновый потомок в группе умершего bash: сторож ждёт его, затем DONE 0", async () => {
  const result = await watchdog([
    "--",
    "bash",
    "-c",
    "sleep 3.7 > /dev/null 2>&1 &",
  ]);
  assert.equal(result.lastLine, "DONE 0");
  assert.equal(result.code, 0);
  assert.ok(result.seconds >= 3.5, `заняло ${String(result.seconds)} с`);
  assert.deepEqual(await aliveCommands("sleep 3.7"), []);
});

void test("фоновый молчащий потомок после выхода bash → STALLED silence, группа убита", async () => {
  const result = await watchdog([
    "--silence",
    "2",
    "--",
    "bash",
    "-c",
    recordGroup("sleep 123.45 > /dev/null 2>&1 &", home),
  ]);
  try {
    assert.equal(result.code, 76);
    assert.equal(result.lastLine, "STALLED silence");
    assert.deepEqual(await aliveCommands("sleep 123.45"), []);
  } finally {
    await killRecorded(home);
  }
});

void test("потребитель закрыл канал (EPIPE) → группа убита, сирот нет", async () => {
  const child = spawn(
    process.execPath,
    [
      WATCHDOG,
      "--",
      "sh",
      "-c",
      recordGroup(
        "echo a; sleep 0.5; echo b; sleep 0.5; echo c; exec sleep 77.7 >/dev/null 2>&1",
        home,
      ),
    ],
    { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.once("data", () => child.stdout.destroy());
  const closed = new Promise<void>((resolve) => child.on("close", resolve));
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    await closed;
    assert.deepEqual(await aliveCommands("sleep 77.7"), []);
  } finally {
    clearTimeout(timer);
    await killRecorded(home);
  }
});

void test("тишина вывода не зависание: растущее процессорное время в пределах окна тишины → ceiling", async () => {
  const result = await watchdog([
    "--silence",
    "4",
    "--max-seconds",
    "6",
    "--",
    process.execPath,
    "-e",
    "for(;;){}",
  ]);
  assert.equal(result.code, 76);
  assert.equal(result.lastLine, "STALLED ceiling");
  assert.match(result.stdout, /WATCHDOG: остановлен: потолок/);
});

void test("новые потомки каждую секунду — жизнь → ceiling", async () => {
  const result = await watchdog([
    "--silence",
    "3",
    "--max-seconds",
    "7",
    "--",
    "sh",
    "-c",
    "while true; do sleep 1; done",
  ]);
  assert.equal(result.code, 76);
  assert.equal(result.lastLine, "STALLED ceiling");
});

void test("рост --watch-file — жизнь → ceiling", async () => {
  const file = path.join(home, "watched.log");
  const result = await watchdog([
    "--silence",
    "3",
    "--max-seconds",
    "6",
    "--watch-file",
    file,
    "--",
    "sh",
    "-c",
    `while true; do echo x >> ${file}; sleep 0.5; done`,
  ]);
  assert.equal(result.lastLine, "STALLED ceiling");
});

const LIMIT_TEXT =
  "Error: Reached free model rate limit. Your limit will reset in 3 minutes.";

void test("RATE_LIMIT devin: reset in 3 minutes → epoch ≈ now+180, файл 0600 в каталоге 0700", async () => {
  const before = Math.floor(Date.now() / 1000);
  const result = await watchdog([
    "--",
    path.join(bin, "devin"),
    "-p",
    "-c",
    `echo '${LIMIT_TEXT}'; exit 1`,
  ]);
  assert.equal(result.code, 75);
  const match = /^RATE_LIMIT (\d+)$/.exec(result.lastLine);
  assert.ok(match?.[1] !== undefined, result.lastLine);
  const epoch = Number(match[1]);
  assert.ok(Math.abs(epoch - (before + 180)) <= 10, String(epoch - before));
  const directory = path.join(home, ".local", "state", "executor-limits");
  const file = path.join(directory, "devin");
  const directoryInfo = await stat(directory);
  const fileInfo = await stat(file);
  assert.equal(directoryInfo.mode & 0o777, 0o700);
  assert.equal(fileInfo.mode & 0o777, 0o600);
  assert.equal(await readFile(file, "utf8"), `${String(epoch)}\n`);
  assert.deepEqual(await readdir(directory), ["devin"]);
});

void test("RATE_LIMIT pi: без «reset in» → epoch ≈ now+1800, файл pi", async () => {
  const before = Math.floor(Date.now() / 1000);
  const result = await watchdog([
    "--",
    path.join(bin, "pi"),
    "-c",
    "echo 'Error 429: rate limit'; exit 1",
  ]);
  assert.equal(result.code, 75);
  const epoch = Number(/^RATE_LIMIT (\d+)$/.exec(result.lastLine)?.[1]);
  assert.ok(Math.abs(epoch - (before + 1800)) <= 10);
  const file = path.join(home, ".local", "state", "executor-limits", "pi");
  assert.equal(await readFile(file, "utf8"), `${String(epoch)}\n`);
});

void test("не лимит: «429» в выводе при коде 0 → DONE 0, файл не пишется", async () => {
  const other = await mkdtemp(path.join(tmpdir(), "watchdog-nolimit-"));
  try {
    const result = await watchdog(
      [
        "--",
        path.join(bin, "devin"),
        "-p",
        "-c",
        "echo 'status 429 quota'; exit 0",
      ],
      other,
    );
    assert.equal(result.code, 0);
    assert.equal(result.lastLine, "DONE 0");
    await assert.rejects(
      stat(path.join(other, ".local", "state", "executor-limits")),
    );
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

void test("devin с «quota» в обычном выводе и кодом 1 → не лимит, файл не пишется", async () => {
  const other = await mkdtemp(path.join(tmpdir(), "watchdog-quota-"));
  try {
    const result = await watchdog(
      ["--", path.join(bin, "devin"), "-p", "-c", "echo 'quota.ts'; exit 1"],
      other,
    );
    assert.equal(result.code, 1);
    assert.equal(result.lastLine, "DONE 1");
    await assert.rejects(
      stat(path.join(other, ".local", "state", "executor-limits")),
    );
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

void test("pi с «quota» и кодом 1 → RATE_LIMIT", async () => {
  const other = await mkdtemp(path.join(tmpdir(), "watchdog-quota-pi-"));
  try {
    const result = await watchdog(
      ["--", path.join(bin, "pi"), "-c", "echo 'quota exceeded'; exit 1"],
      other,
    );
    assert.equal(result.code, 75);
    assert.match(result.lastLine, /^RATE_LIMIT \d+$/);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

void test("RATE_LIMIT codex: «usage limit», «RateLimitReached», «usage_limited» → 75, файл codex", async () => {
  for (const phrase of [
    "You've hit your usage limit",
    "RateLimitReached",
    "usage_limited",
  ]) {
    const other = await mkdtemp(path.join(tmpdir(), "watchdog-codex-"));
    try {
      const before = Math.floor(Date.now() / 1000);
      const result = await watchdog(
        ["--", codexScript, "exec", "-c", `echo "${phrase}"; exit 1`],
        other,
      );
      assert.equal(result.code, 75, phrase);
      const epoch = Number(/^RATE_LIMIT (\d+)$/.exec(result.lastLine)?.[1]);
      assert.ok(
        Math.abs(epoch - (before + 1800)) <= 10,
        `${phrase}: ${String(epoch - before)}`,
      );
      const file = path.join(
        other,
        ".local",
        "state",
        "executor-limits",
        "codex",
      );
      assert.equal(await readFile(file, "utf8"), `${String(epoch)}\n`, phrase);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  }
});

/**
 * Содержимое каталога или пустой список, когда его нет.
 */
async function directoryNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

/**
 * Ждём появления файла замка (<base>/locks/<ключ>) и читаем
 * «pgid\npid сторожа\nфайл вывода» — после перезаписи с pgid.
 */
async function waitLock(
  directory: string,
): Promise<{ pgid: number; pid: number; output: string }> {
  const locks = path.join(
    directory,
    ".local",
    "state",
    "executor-limits",
    "locks",
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const names = await directoryNames(locks);
    const name = names.find((item) => !item.includes(".tmp-"));
    if (name !== undefined) {
      const text = await readFile(path.join(locks, name), "utf8");
      const [pgidText, pidText, ...rest] = text.split("\n");
      const pgid = Number(pgidText);
      const pid = Number(pidText);
      if (Number.isSafeInteger(pgid) && pgid > 0) {
        return { pgid, pid, output: rest.join("\n").trim() };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("замок не появился");
}

void test("BUSY: та же команда при живом первом запуске → код 77, строка BUSY; после завершения — стартует", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-busy-"));
  const outFile = path.join(directory, "run.out");
  const arguments_ = [
    "--silence",
    "30",
    "--",
    "sh",
    "-c",
    recordGroup(`sleep 4.23 > '${outFile}'`, directory),
  ];
  const first = spawn(process.execPath, [WATCHDOG, ...arguments_], {
    env: { ...process.env, HOME: directory },
    stdio: "ignore",
  });
  try {
    const lock = await waitLock(directory);
    assert.equal(lock.output, outFile);
    const second = await watchdog(arguments_, directory);
    assert.equal(second.code, 77);
    assert.equal(second.lastLine, `BUSY ${String(lock.pgid)} ${outFile}`);
    // другая команда — не дубликат: запускается свободно
    const other = await watchdog(["--", "sh", "-c", "echo иначе"], directory);
    assert.equal(other.lastLine, "DONE 0");
    // первый дошёл до конца: замок снят, команда снова стартует
    await new Promise((resolve) => first.on("close", resolve));
    const third = await watchdog(arguments_, directory);
    assert.equal(third.lastLine, "DONE 0");
    // замок и его каталоги подчищены (выше базы не поднимаемся)
    await assert.rejects(
      stat(path.join(directory, ".local", "state", "executor-limits")),
    );
  } finally {
    first.kill("SIGKILL"); // при провале теста; обычно уже завершён
    await killRecorded(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

void test("BUSY: каталог исчез при проверке владельца — взятие повторяется", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "watchdog-reclaim-directory-"),
  );
  const file = path.join(directory, "lock");
  await writeFile(file, "0\n0\nstale\n");
  try {
    const held = await acquireLock(
      file,
      "recovered.out",
      async (): Promise<undefined> => {
        await rm(directory, { recursive: true, force: true });
        return undefined;
      },
    );
    assert.equal(held, undefined);
    assert.match(await readFile(file, "utf8"), /recovered.out/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("BUSY: второй уборщик протухшего замка не удаляет нового владельца", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-reclaim-"));
  const file = path.join(directory, "lock");
  const bothRead = Promise.withResolvers<undefined>();
  const replaced = Promise.withResolvers<undefined>();
  await writeFile(file, "0\n0\nstale\n");
  try {
    const first = acquireLock(file, "first.out", () => bothRead.promise);
    const second = acquireLock(file, "second.out", () => {
      bothRead.resolve(undefined);
      return replaced.promise;
    });
    assert.equal(await first, undefined);
    replaced.resolve(undefined);
    const held = await second;
    assert.equal(held?.pid, process.pid);
    assert.equal(held.output, "first.out");
    assert.match(await readFile(file, "utf8"), /first.out/);
  } finally {
    bothRead.resolve(undefined);
    replaced.resolve(undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

void test("BUSY: замок с мёртвым pid — протухший, команда стартует, замок перезаписан и снят", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-stale-"));
  try {
    // гарантированно мёртвый pid: процесс уже завершился
    const dead = spawn("true", []);
    await new Promise((resolve) => dead.on("exit", resolve));
    const deadPid = dead.pid ?? 1;
    const command = ["sh", "-c", "echo ok"];
    const locks = path.join(
      directory,
      ".local",
      "state",
      "executor-limits",
      "locks",
    );
    await mkdir(locks, { recursive: true });
    const file = runLockFile(command, locks);
    await writeFile(file, `0\n${String(deadPid)}\nold.out\n`);
    const result = await watchdog(["--", ...command], directory);
    assert.equal(result.lastLine, "DONE 0");
    // замок и его каталоги подчищены (выше базы не поднимаемся)
    await assert.rejects(
      stat(path.join(directory, ".local", "state", "executor-limits")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("BUSY: каталог ограничений переопределяется EXECUTOR_LIMITS_DIR", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-env-"));
  const limits = path.join(directory, "custom-limits");
  const arguments_ = [
    "--silence",
    "30",
    "--",
    "sh",
    "-c",
    recordGroup("sleep 4.23", directory),
  ];
  const first = spawn(process.execPath, [WATCHDOG, ...arguments_], {
    env: { ...process.env, HOME: directory, EXECUTOR_LIMITS_DIR: limits },
    stdio: "ignore",
  });
  try {
    // замок появился в переопределённом каталоге
    const locks = path.join(limits, "locks");
    let file: string | undefined;
    for (let attempt = 0; file === undefined && attempt < 100; attempt += 1) {
      const names = await directoryNames(locks);
      file = names.find((item) => !item.includes(".tmp-"));
      if (file === undefined)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(file !== undefined, "замок не появился в EXECUTOR_LIMITS_DIR");
    const second = await watchdog(arguments_, directory, {
      EXECUTOR_LIMITS_DIR: limits,
    });
    assert.equal(second.code, 77);
    assert.match(second.lastLine, /^BUSY \d+ /);
  } finally {
    first.kill("SIGKILL");
    await killRecorded(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

void test("runLockFile: кавычки, пробелы и границы аргументов сохраняют смысл задания", () => {
  const different: [string[], string[]][] = [
    [
      ["bash", "-c", 'codex exec "Check x > 3"'],
      ["bash", "-c", 'codex exec "Check x > 4"'],
    ],
    [
      ["bash", "-c", "codex exec 'Check x > 3'"],
      ["bash", "-c", "codex exec 'Check x > 4'"],
    ],
    [
      ["codex", "exec", "Check x > 3"],
      ["codex", "exec", "Check x > 4"],
    ],
    [
      ["codex", "exec", "a b"],
      ["codex", "exec", "a", "b"],
    ],
    [
      ["bash", "-c", 'codex exec "a  b"'],
      ["bash", "-c", 'codex exec "a b"'],
    ],
    [
      ["bash", "-c", String.raw`codex exec x\>3`],
      ["bash", "-c", String.raw`codex exec x\>4`],
    ],
  ];
  for (const [a, b] of different) {
    assert.notEqual(
      runLockFile(a, "/tmp/locks"),
      runLockFile(b, "/tmp/locks"),
      JSON.stringify([a, b]),
    );
  }
  for (const option of ["-lc", "-ec"]) {
    assert.equal(
      runLockFile(["bash", option, 'codex exec "check" > first'], "/tmp/locks"),
      runLockFile(
        ["bash", option, 'codex exec "check" > second'],
        "/tmp/locks",
      ),
    );
  }
  assert.equal(
    runLockFile(
      ["bash", "-c", 'codex exec "Check x > 3" > "first out" 2>&1'],
      "/tmp/locks",
    ),
    runLockFile(
      ["bash", "-c", 'codex exec "Check x > 3" >> second'],
      "/tmp/locks",
    ),
  );
});

void test("runLockFile: разные рабочие каталоги независимы, ссылка ведёт к тому же ключу", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-cwd-"));
  const original = process.cwd();
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  const alias = path.join(directory, "alias");
  await mkdir(first);
  await mkdir(second);
  await symlink(first, alias);
  const command = ["codex", "exec", "review this repository"];
  try {
    process.chdir(first);
    const key = runLockFile(command, "/tmp/locks", "codex");
    assert.equal(key, runLockFile(command, "/tmp/locks", "codex"));
    process.chdir(second);
    assert.notEqual(key, runLockFile(command, "/tmp/locks", "codex"));
    process.chdir(alias);
    assert.equal(key, runLockFile(command, "/tmp/locks", "codex"));
  } finally {
    process.chdir(original);
    await rm(directory, { recursive: true, force: true });
  }
});

void test("runLockFile: ключ — исполнитель + prompt-файл, редиректы вывода не влияют", () => {
  const directory = "/tmp/locks";
  const key = runLockFile(
    ["bash", "-c", "cd /w && devin -p --prompt-file t.md > run24"],
    directory,
    "devin",
  );
  // тот же prompt-файл при другом «> файл» — тот же замок
  assert.equal(
    key,
    runLockFile(
      ["bash", "-c", "cd /w && devin -p --prompt-file t.md > run24-new 2>&1"],
      directory,
      "devin",
    ),
  );
  // обёртка bash -c и cd не меняют абсолютный путь
  assert.equal(
    key,
    runLockFile(
      ["devin", "-p", "--prompt-file", "/w/t.md"],
      directory,
      "devin",
    ),
  );
  // другой prompt-файл — другой замок
  assert.notEqual(
    key,
    runLockFile(
      ["bash", "-c", "cd /w && devin -p --prompt-file t2.md > run24"],
      directory,
      "devin",
    ),
  );
  // без prompt-файла: редиректы вывода не входят в ключ
  assert.equal(
    runLockFile(["sh", "-c", "sleep 1 > /tmp/a"], directory),
    runLockFile(["sh", "-c", "sleep 1 >> /tmp/b 2>&1"], directory),
  );
  // «cd <dir> &&» — часть идентичности
  assert.notEqual(
    runLockFile(["sh", "-c", "cd /a && sleep 1 > x"], directory),
    runLockFile(["sh", "-c", "cd /b && sleep 1 > x"], directory),
  );
  // исполнитель — часть ключа
  assert.notEqual(
    runLockFile(
      ["devin", "-p", "--prompt-file", "/w/t.md"],
      directory,
      "devin",
    ),
    runLockFile(["pi", "--prompt-file", "/w/t.md"], directory, "pi"),
  );
});

void test("BUSY: тот же --prompt-file с другим «> файл» — тот же замок, повтор не стартует", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-promptkey-"));
  const prompt = path.join(directory, "task.md");
  const otherPrompt = path.join(directory, "other.md");
  await writeFile(prompt, "x");
  await writeFile(otherPrompt, "y");
  const devin = path.join(bin, "devin");
  const make = (out: string) => [
    "--",
    "bash",
    "-c",
    recordGroup(
      `${devin} -p --prompt-file '${prompt}' -c 'sleep 4.23' > '${out}'`,
      directory,
    ),
  ];
  const first = spawn(
    process.execPath,
    [WATCHDOG, ...make(path.join(directory, "run24"))],
    { env: { ...process.env, HOME: directory }, stdio: "ignore" },
  );
  try {
    const lock = await waitLock(directory);
    // тот же prompt-файл, другой файл вывода — дубликат
    const second = await watchdog(
      make(path.join(directory, "run24-new")),
      directory,
    );
    assert.equal(second.code, 77);
    assert.equal(
      second.lastLine,
      `BUSY ${String(lock.pgid)} ${path.join(directory, "run24")}`,
    );
    // другой prompt-файл — не дубликат
    const third = await watchdog(
      [
        "--",
        "bash",
        "-c",
        `${devin} -p --prompt-file '${otherPrompt}' -c 'echo ok' > '${path.join(directory, "run24")}'`,
      ],
      directory,
    );
    assert.equal(third.lastLine, "DONE 0");
  } finally {
    first.kill("SIGKILL");
    await killRecorded(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

void test("BUSY: два сторожа с той же командой одновременно — ровно один BUSY, второй DONE", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-race-"));
  const arguments_ = ["--", "sh", "-c", "sleep 1.5; echo winner"];
  try {
    const [a, b] = await Promise.all([
      watchdog(arguments_, directory),
      watchdog(arguments_, directory),
    ]);
    const codes = [a.code, b.code].toSorted(
      (left, right) => (left ?? -1) - (right ?? -1),
    );
    assert.deepEqual(codes, [0, 77], `a=${String(a.code)} b=${String(b.code)}`);
    const busy = a.code === 77 ? a : b;
    assert.match(busy.lastLine, /^BUSY \d+ /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("STALLED: группа пережила остановку — замок остаётся, повтор той же команды → BUSY", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-stalled-"));
  // perl уходит в свою группу и не ждёт ребёнка: зомби держит pgid первой
  // группы «живым» для kill(-pgid, 0) и после SIGKILL сторожа
  const arguments_ = [
    "--silence",
    "2",
    "--",
    "sh",
    "-c",
    String.raw`echo $$ >> '${path.join(directory, "group.pid")}'; perl -e 'open(F, ">>", $ARGV[0]) or die $!; print F "$$\n"; close F; $k=fork; if($k==0){sleep 0.1; exit 0} setpgrp(0,0); sleep 611.31' '${path.join(directory, "escaped.pid")}' & exec sleep 611.31`,
  ];
  try {
    const first = await watchdog(arguments_, directory);
    assert.equal(first.code, 76);
    assert.equal(first.lastLine, "STALLED silence");
    const second = await watchdog(arguments_, directory);
    assert.equal(second.code, 77);
    assert.match(second.lastLine, /^BUSY \d+ /);
  } finally {
    await killRecorded(directory, "escaped.pid");
    await killRecorded(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

void test("замок: чистка каталогов не поднимается выше базы EXECUTOR_LIMITS_DIR", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-cleanup-"));
  const limits = path.join(directory, "deep", "nested", "limits");
  try {
    const result = await watchdog(["--", "sh", "-c", "echo ok"], directory, {
      EXECUTOR_LIMITS_DIR: limits,
    });
    assert.equal(result.lastLine, "DONE 0");
    // locks и сама база подчищены, родители базы — на месте
    await assert.rejects(stat(limits));
    await stat(path.join(directory, "deep", "nested"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("pi с «usageLimit»/«usage-limit»/«usage_limit» в выводе и кодом 1 → не лимит", async () => {
  for (const phrase of ["usageLimit", "usage-limit", "usage_limit"]) {
    const other = await mkdtemp(path.join(tmpdir(), "watchdog-usagelimit-"));
    try {
      const result = await watchdog(
        [
          "--",
          path.join(bin, "pi"),
          "-c",
          `echo 'code has ${phrase} = 1'; exit 1`,
        ],
        other,
      );
      assert.equal(result.code, 1, phrase);
      assert.equal(result.lastLine, "DONE 1", phrase);
      await assert.rejects(
        stat(path.join(other, ".local", "state", "executor-limits", "pi")),
        phrase,
      );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  }
});

void test("остановка сторожем + признак лимита в хвосте → RATE_LIMIT, а не STALLED", async () => {
  const result = await watchdog([
    "--silence",
    "2",
    "--",
    path.join(bin, "pi"),
    "-c",
    "echo 'too many requests'; sleep 60; true",
  ]);
  assert.equal(result.code, 75);
  assert.match(result.lastLine, /^RATE_LIMIT \d+$/);
  assert.match(result.stdout, /WATCHDOG: остановлен/);
});

void test("detectExecutor: прямая команда, sh -c со строкой, неизвестная", () => {
  assert.equal(detectExecutor(["devin", "-p", "задача"]), "devin");
  assert.equal(detectExecutor(["/usr/local/bin/pi", "-p", "x"]), "pi");
  assert.equal(
    detectExecutor(["bash", "-c", "cd /tmp && devin -p 'x' > out; echo done"]),
    "devin",
  );
  assert.equal(detectExecutor(["sh", "-c", "pi -p x"]), "pi");
  for (const line of [
    "env X=1 devin -p x",
    "timeout 600 devin -p x",
    "nohup devin -p x",
    "cd d; VAR=1 devin -p x",
    "nice -n 5 pi -p x",
    "exec env A=b timeout -k 5 60 pi -p x",
    "true && ( devin -p x ) &",
  ]) {
    assert.ok(
      detectExecutor(["bash", "-c", line]) !== undefined,
      `bash -c ${line}`,
    );
  }
  assert.equal(detectExecutor(["env", "X=1", "devin", "-p", "x"]), "devin");
  assert.equal(detectExecutor(["codex", "exec", "задача"]), "codex");
  assert.equal(detectExecutor(["codex", "exec", "review", "план"]), "codex");
  assert.equal(detectExecutor(["/usr/local/bin/codex", "exec", "x"]), "codex");
  assert.equal(
    detectExecutor(["bash", "-c", "cd /x && codex exec 't' > run.out"]),
    "codex",
  );
  assert.equal(detectExecutor(["bash", "-c", "echo 5 devin -p"]), undefined);
  assert.equal(detectExecutor(["devin", "--version"]), undefined);
  assert.equal(detectExecutor(["codex"]), undefined);
  assert.equal(detectExecutor(["codex", "--version"]), undefined);
  assert.equal(detectExecutor(["codex", "exec-foo", "x"]), undefined);
  assert.equal(detectExecutor(["sh", "-c", "ls -la"]), undefined);
  assert.equal(detectExecutor(["sleep", "1"]), undefined);
});

void test("findRateLimit: признак ищется в хвосте, reset in N minutes|hours", () => {
  const now = 1_000_000_000_000;
  assert.equal(
    findRateLimit(
      "Reached free model rate limit. reset in 2 hours",
      "devin",
      now,
    ),
    1_000_000_000 + 7200,
  );
  assert.equal(
    findRateLimit("Too Many Requests", "devin", now),
    1_000_000_000 + 1800,
  );
  assert.equal(
    findRateLimit("reset in 3 minutes, quota", "pi", now),
    1_000_000_000 + 1800,
  );
  assert.equal(findRateLimit("quota exceeded", "devin", now), undefined);
  assert.equal(findRateLimit("generic rate limit", "devin", now), undefined);
  assert.ok(findRateLimit("quota exceeded", "pi", now) !== undefined);
  assert.ok(findRateLimit("quota exceeded", undefined, now) !== undefined);
  assert.equal(
    findRateLimit("You've hit your usage limit", "codex", now),
    1_000_000_000 + 1800,
  );
  assert.equal(
    findRateLimit("RateLimitReached", "codex", now),
    1_000_000_000 + 1800,
  );
  assert.equal(
    findRateLimit("usage limit exceeded", "codex", now),
    1_000_000_000 + 1800,
  );
  assert.equal(
    findRateLimit("usage_limit_reached", "codex", now),
    1_000_000_000 + 1800,
  );
  assert.equal(
    findRateLimit("usage_limited", "codex", now),
    1_000_000_000 + 1800,
  );
  // usage.?limit — идентификаторы и обычный текст: для pi не лимит
  assert.equal(findRateLimit("usageLimit", "pi", now), undefined);
  assert.equal(findRateLimit("usage-limit", "pi", now), undefined);
  assert.equal(findRateLimit("usage_limit", "pi", now), undefined);
  assert.equal(findRateLimit("usage limit exceeded", "pi", now), undefined);
  assert.equal(findRateLimit("usage_limited", "pi", now), undefined);
  assert.equal(findRateLimit("всё хорошо", "devin", now), undefined);
  assert.equal(findRateLimit("порт 4290 занят", "devin", now), undefined);
});

void test("parseWatchdogArguments: опции до --, команда после", () => {
  assert.deepEqual(
    parseWatchdogArguments([
      "--silence",
      "5",
      "--max-seconds",
      "9",
      "--",
      "a",
      "-b",
    ]),
    { silence: 5, maxSeconds: 9, command: ["a", "-b"] },
  );
  assert.deepEqual(parseWatchdogArguments(["--", "x"]), {
    silence: 600,
    maxSeconds: undefined,
    command: ["x"],
  });
  assert.equal(
    parseWatchdogArguments(["--alert-file", "/t/a.jsonl", "--", "x"]).alertFile,
    "/t/a.jsonl",
  );
  assert.throws(() => parseWatchdogArguments(["--silence", "5"]));
  assert.throws(() => parseWatchdogArguments(["--silence", "abc", "--", "x"]));
});

void test("writeLimitFile: атомарно, перезаписывает, временных файлов не остаётся", async () => {
  const directory = path.join(home, "limits-unit");
  await writeLimitFile(directory, "devin", 111);
  await writeLimitFile(directory, "devin", 222);
  assert.equal(await readFile(path.join(directory, "devin"), "utf8"), "222\n");
  assert.deepEqual(await readdir(directory), ["devin"]);
  const info = await stat(path.join(directory, "devin"));
  assert.equal(info.mode & 0o777, 0o600);
});

void test("родитель сторожа вышел раньше задачи: задача не убивается, итог DONE 0", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wd-parent-"));
  const out = path.join(directory, "out.txt");
  // оболочка запускает сторож в фоне и сразу выходит (как `nohup … &`)
  const shell = spawn(
    "sh",
    [
      "-c",
      `node '${WATCHDOG}' --silence 30 -- sh -c 'sleep 2; echo работа' > '${out}' 2>&1 & sleep 1; exit 0`,
    ],
    { env: { ...process.env, HOME: directory }, stdio: "ignore" },
  );
  await new Promise((resolve) => shell.on("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const text = await readFile(out, "utf8");
  assert.match(text, /работа/);
  assert.match(text, /DONE 0\s*$/);
  await rm(directory, { recursive: true, force: true });
});

void test("вывод исполнителя уходит в файл (как у раннеров): лимит ищется в --watch-file, код берётся из строки exit=", async () => {
  const before = Math.floor(Date.now() / 1000);
  const limitHome = await mkdtemp(path.join(tmpdir(), "watchdog-home-file-"));
  const out = path.join(limitHome, "run.out");
  try {
    const result = await watchdog(
      [
        "--watch-file",
        out,
        "--",
        "bash",
        "-c",
        `cd ${limitHome} && ${path.join(bin, "devin")} -p -c "echo '${LIMIT_TEXT}'; exit 1" > ${out} 2>&1; echo "exit=$?" >> ${out}`,
      ],
      limitHome,
    );
    assert.equal(result.code, 75, result.stdout);
    const epoch = Number(/^RATE_LIMIT (\d+)$/.exec(result.lastLine)?.[1]);
    assert.ok(Math.abs(epoch - (before + 180)) <= 10, result.lastLine);
    const file = path.join(
      limitHome,
      ".local",
      "state",
      "executor-limits",
      "devin",
    );
    assert.equal(await readFile(file, "utf8"), `${String(epoch)}\n`);
  } finally {
    await rm(limitHome, { recursive: true, force: true });
  }
});

void test("вывод в файл, exit=0 и слово «rate limit» в тексте работы → DONE 0, файл лимита не пишется", async () => {
  const limitHome = await mkdtemp(path.join(tmpdir(), "watchdog-home-ok-"));
  const out = path.join(limitHome, "run.out");
  try {
    const result = await watchdog(
      [
        "--watch-file",
        out,
        "--",
        "bash",
        "-c",
        `${path.join(bin, "devin")} -p -c "echo 'обработка rate limit 429 в коде'" > ${out} 2>&1; echo "exit=$?" >> ${out}`,
      ],
      limitHome,
    );
    assert.equal(result.lastLine, "DONE 0");
    await assert.rejects(
      stat(path.join(limitHome, ".local", "state", "executor-limits", "devin")),
    );
  } finally {
    await rm(limitHome, { recursive: true, force: true });
  }
});

// Живые события (TASK-271): сторож завершает запуск за секунды, не дожидаясь выхода.

void test("живой лимит: devin печатает строку лимита и жжёт CPU → RATE_LIMIT < 5 с", async () => {
  const before = Math.floor(Date.now() / 1000);
  const limitHome = await mkdtemp(path.join(tmpdir(), "watchdog-live-limit-"));
  try {
    const result = await watchdog(
      [
        "--max-seconds",
        "30",
        "--",
        path.join(bin, "devin"),
        "-p",
        "-c",
        `echo '${LIMIT_TEXT}'; while :; do :; done`,
      ],
      limitHome,
    );
    assert.equal(result.code, 75, result.stdout);
    assert.ok(result.seconds < 5, `заняло ${String(result.seconds)} с`);
    const epoch = Number(/^RATE_LIMIT (\d+)$/.exec(result.lastLine)?.[1]);
    assert.ok(Math.abs(epoch - (before + 180)) <= 10, result.lastLine);
    assert.match(result.stdout, /WATCHDOG: событие: rate_limit/);
    const file = path.join(
      limitHome,
      ".local",
      "state",
      "executor-limits",
      "devin",
    );
    assert.equal(await readFile(file, "utf8"), `${String(epoch)}\n`);
  } finally {
    await rm(limitHome, { recursive: true, force: true });
  }
});

void test("живой лимит в --watch-file (вывод раннера в файл) → RATE_LIMIT < 5 с", async () => {
  const limitHome = await mkdtemp(path.join(tmpdir(), "watchdog-live-file-"));
  const out = path.join(limitHome, "run.out");
  try {
    const result = await watchdog(
      [
        "--max-seconds",
        "30",
        "--watch-file",
        out,
        "--",
        "bash",
        "-c",
        `${path.join(bin, "devin")} -p -c "echo '${LIMIT_TEXT}'; while :; do :; done" > ${out} 2>&1`,
      ],
      limitHome,
    );
    assert.equal(result.code, 75, result.stdout);
    assert.ok(result.seconds < 5, `заняло ${String(result.seconds)} с`);
    assert.match(result.lastLine, /^RATE_LIMIT \d+$/);
  } finally {
    await rm(limitHome, { recursive: true, force: true });
  }
});

const DEVIN_REJECTED =
  "warning: rejected a tool call that requires confirmation. Running in non-interactive mode. Use --permission-mode dangerous to auto-approve all tools.";

void test("devin отклонил инструмент и вышел с 0 → WAITING, код 78", async () => {
  const result = await watchdog([
    "--",
    path.join(bin, "devin"),
    "-p",
    "-c",
    `echo '${DEVIN_REJECTED}'; exit 0`,
  ]);
  assert.equal(result.code, 78, result.stdout);
  assert.match(result.lastLine, /^WAITING .*rejected a tool call/);
});

void test("devin отклонил инструмент и продолжает работать → WAITING < 5 с", async () => {
  const result = await watchdog([
    "--max-seconds",
    "30",
    "--",
    path.join(bin, "devin"),
    "-p",
    "-c",
    `echo '${DEVIN_REJECTED}'; sleep 60`,
  ]);
  assert.equal(result.code, 78, result.stdout);
  assert.ok(result.seconds < 5, `заняло ${String(result.seconds)} с`);
});

void test("не событие: строка лимита с отступом или в кавычках (cat исходника) при коде 0 → DONE 0", async () => {
  const other = await mkdtemp(path.join(tmpdir(), "watchdog-live-fp-"));
  try {
    const result = await watchdog(
      [
        "--",
        path.join(bin, "devin"),
        "-p",
        "-c",
        `echo '  "${LIMIT_TEXT}"'; echo '"${DEVIN_REJECTED}"'; sleep 1; exit 0`,
      ],
      other,
    );
    assert.equal(result.lastLine, "DONE 0", result.stdout);
    assert.equal(result.code, 0);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

void test("alert-файл: хук пишет waiting/error/rate_limit → WAITING 78 / FAILED 79 / RATE_LIMIT 75 за < 5 с", async () => {
  const cases: [string, number, RegExp][] = [
    ["waiting", 78, /^WAITING exec: rm -rf x$/],
    ["error", 79, /^FAILED exec: rm -rf x$/],
    ["rate_limit", 75, /^RATE_LIMIT \d+$/],
  ];
  for (const [type, code, line] of cases) {
    const other = await mkdtemp(path.join(tmpdir(), "watchdog-alert-"));
    try {
      const event = JSON.stringify({
        type,
        source: "pi",
        message: "exec: rm -rf x",
      });
      const result = await watchdog(
        [
          "--max-seconds",
          "30",
          "--",
          path.join(bin, "pi"),
          "-c",
          `echo 'not json' >> "$HARNESS_ALERT_FILE"; echo '${event}' >> "$HARNESS_ALERT_FILE"; sleep 60`,
        ],
        other,
      );
      assert.equal(result.code, code, `${type}: ${result.stdout}`);
      assert.match(result.lastLine, line);
      assert.ok(result.seconds < 5, `заняло ${String(result.seconds)} с`);
      // файл по умолчанию — в каталоге ограничений и удалён по завершении
      const alerts = path.join(
        other,
        ".local",
        "state",
        "executor-limits",
        "alerts",
      );
      await assert.rejects(stat(alerts));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  }
});

void test("alert-файл: событие записано перед выходом с кодом 0 → вердикт события, явный --alert-file не удаляется", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "watchdog-alert-exit-"));
  const alert = path.join(directory, "alert.jsonl");
  try {
    const event = JSON.stringify({ type: "waiting", message: "confirm" });
    const result = await watchdog([
      "--alert-file",
      alert,
      "--",
      "sh",
      "-c",
      `test "$HARNESS_ALERT_FILE" = '${alert}' && echo '${event}' >> "$HARNESS_ALERT_FILE"; exit 0`,
    ]);
    assert.equal(result.code, 78, result.stdout);
    assert.equal(result.lastLine, "WAITING confirm");
    assert.match(await readFile(alert, "utf8"), /confirm/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("ожидание ввода со стандартного ввода не вешает запуск: stdin ребёнка — /dev/null", async () => {
  const child = spawn(
    process.execPath,
    [WATCHDOG, "--max-seconds", "20", "--", "sh", "-c", "read x; echo got=$?"],
    { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const started = Date.now();
  await new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });
  child.stdin.destroy();
  assert.ok(Date.now() - started < 5000, stdout);
  assert.match(stdout, /got=1/);
});

void test("CPU без вывода дольше окна тишины — не жизнь → STALLED silence раньше потолка", async () => {
  const result = await watchdog([
    "--silence",
    "2",
    "--max-seconds",
    "20",
    "--",
    process.execPath,
    "-e",
    "for(;;){}",
  ]);
  assert.equal(result.code, 76);
  assert.equal(result.lastLine, "STALLED silence");
  assert.ok(result.seconds < 12, `заняло ${String(result.seconds)} с`);
});

void test("liveEvent: только завершённые строки, обрезанная первая строка окна отброшена", () => {
  const line = "Reached free model rate limit. Reset in 2 minutes.";
  assert.deepEqual(liveEvent(`${line}\n`, "devin"), {
    type: "rate_limit",
    message: line,
  });
  assert.equal(liveEvent(line, "devin"), undefined); // строка ещё пишется
  assert.equal(liveEvent(`${line}\nok\n`, "devin", true), undefined);
  assert.equal(liveEvent(`x\n${line}\n`, "devin", true)?.type, "rate_limit");
  assert.equal(liveEvent(`${line}\n`, "pi"), undefined); // у Pi — расширение
  assert.equal(liveEvent(`${line}\n`, undefined), undefined);
  assert.equal(
    liveEvent(
      "[2026-10-04T10:00:00] ERROR: You've hit your usage limit.\n",
      "codex",
    )?.type,
    "rate_limit",
  );
  assert.equal(
    liveEvent("  /you've hit your usage limit|usage_limit_reached/\n", "codex"),
    undefined,
  );
});
