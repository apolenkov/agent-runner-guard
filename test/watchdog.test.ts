import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { listProcesses } from "../src/proc.ts";
import {
  detectExecutor,
  findRateLimit,
  parseWatchdogArguments,
  writeLimitFile,
} from "../src/watchdog.ts";

const WATCHDOG = fileURLToPath(new URL("../src/watchdog.ts", import.meta.url));

const home = await mkdtemp(path.join(tmpdir(), "watchdog-home-"));
const bin = path.join(home, "bin");
await mkdir(bin);
await symlink("/bin/sh", path.join(bin, "devin"));
await symlink("/bin/sh", path.join(bin, "pi"));

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
function watchdog(arguments_: string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [WATCHDOG, ...arguments_], {
      env: { ...process.env, HOME: home },
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

void test("тишина вывода не зависание: растущее процессорное время → ceiling", async () => {
  const result = await watchdog([
    "--silence",
    "2",
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
    const result = await new Promise<Result>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          WATCHDOG,
          "--",
          path.join(bin, "devin"),
          "-p",
          "-c",
          "echo 'status 429 quota'; exit 0",
        ],
        { env: { ...process.env, HOME: other } },
      );
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.on("close", (code) => {
        resolve({
          stdout,
          stderr: "",
          code,
          lastLine: stdout.trimEnd().split("\n").at(-1) ?? "",
          seconds: 0,
        });
      });
    });
    assert.equal(result.code, 0);
    assert.equal(result.lastLine, "DONE 0");
    await assert.rejects(stat(path.join(other, ".local")));
  } finally {
    await rm(other, { recursive: true, force: true });
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
  assert.equal(detectExecutor(["devin", "--version"]), undefined);
  assert.equal(detectExecutor(["sh", "-c", "ls -la"]), undefined);
  assert.equal(detectExecutor(["sleep", "1"]), undefined);
});

void test("findRateLimit: признак ищется в хвосте, reset in N minutes|hours", () => {
  const now = 1_000_000_000_000;
  assert.equal(
    findRateLimit("rate limit. reset in 2 hours", "devin", now),
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
