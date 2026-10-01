/**
 * Сторож запусков Devin и Pi: `node src/watchdog.ts [--silence <сек>]
 * [--max-seconds <сек>] [--watch-file <путь>] -- <команда> [аргументы…]`.
 * Запускает команду в своей группе процессов, пробрасывает вывод, раз в
 * 2 с ищет признаки жизни; при тишине или превышении потолка останавливает
 * ТОЛЬКО свою группу. Последняя строка stdout: DONE <код> |
 * RATE_LIMIT <epoch> | STALLED <silence|ceiling>.
 * Коды выхода: код команды (75 и 76 → 1), 75 — лимит, 76 — зависание.
 */
import { spawn } from "node:child_process";
import { mkdir, chmod, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, homedir } from "node:os";
import path from "node:path";

import { listProcesses } from "./proc.ts";
import {
  cpuTimeSum,
  executorOf,
  findAcpLog,
  isDevinAcp,
} from "./sources/devin-process.ts";
import type { Executor } from "./source.ts";

const TAIL_BYTES = 64 * 1024;
const POLL_MS = 2000;
const TICK_MS = 200;
const TERM_GRACE_MS = 5000;
const DEFAULT_SILENCE = 600;
const DEFAULT_RESET_SECONDS = 30 * 60;
// Devin: «quota» бывает в обычном коде, поэтому ищем только его формулировку.
const DEVIN_LIMIT_PATTERN =
  /Reached free model rate limit|too many requests|\b429\b/i;
const OTHER_LIMIT_PATTERN = /rate.?limit|too many requests|\b429\b|quota/i;
// Обёртки и приставки перед настоящей командой: env, VAR=1, timeout 600, …
const PREFIX_TOKEN = /^(?:env|nohup|nice|exec|timeout|\w+=.*|-\S*|\d+[smhd]?)$/;

export interface WatchdogArguments {
  silence: number;
  maxSeconds: number | undefined;
  watchFile?: string;
  command: string[];
}

/**
 * Разбор аргументов: опции до `--`, команда после. Ошибка — исключение.
 */
export function parseWatchdogArguments(argv: string[]): WatchdogArguments {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error("нужна команда после --");
  }
  const result: WatchdogArguments = {
    silence: DEFAULT_SILENCE,
    maxSeconds: undefined,
    command: argv.slice(separator + 1),
  };
  const options = argv.slice(0, separator);
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (value === undefined) throw new Error(`у ${String(name)} нет значения`);
    if (name === "--watch-file") {
      result.watchFile = value;
    } else if (name === "--silence" || name === "--max-seconds") {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`${name}: нужно положительное число`);
      }
      if (name === "--silence") result.silence = seconds;
      else result.maxSeconds = seconds;
    } else {
      throw new Error(`неизвестная опция ${String(name)}`);
    }
  }
  return result;
}

/**
 * Исполнитель по команде: прямой `devin … -p …` / `pi …` либо
 * `sh|bash -c "<строка>"` — по первой подходящей команде строки.
 */
export function detectExecutor(command: string[]): Executor | undefined {
  const [binary, ...rest] = command;
  if (binary === undefined) return undefined;
  const direct = executorInLine(command.join(" "));
  if (direct !== undefined) return direct;
  if (!/^(?:ba|z)?sh$/.test(path.basename(binary))) return undefined;
  if (!rest.includes("-c")) return undefined;
  const script = rest[rest.indexOf("-c") + 1];
  if (script === undefined) return undefined;
  for (const part of script.split(/[;&|\n]+/)) {
    const executor = executorInLine(part);
    if (executor !== undefined) return executor;
  }
  return undefined;
}

/*
 * Исполнитель простой команды после обёрток (`env X=1`, `timeout 60`, …).
 */
function executorInLine(line: string): Executor | undefined {
  const tokens = line
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^\(+/, ""))
    .filter((token) => token !== "");
  const index = tokens.findIndex((token) => !PREFIX_TOKEN.test(token));
  return index === -1 ? undefined : executorOf(tokens.slice(index).join(" "));
}

/**
 * Время сброса лимита (секунды эпохи) по хвосту вывода; признака нет —
 * undefined. Devin: «reset in N minutes|hours», иначе и для Pi — 30 минут.
 */
export function findRateLimit(
  tail: string,
  executor: Executor | undefined,
  nowMs: number,
): number | undefined {
  const pattern =
    executor === "devin" ? DEVIN_LIMIT_PATTERN : OTHER_LIMIT_PATTERN;
  if (!pattern.test(tail)) return undefined;
  let seconds = DEFAULT_RESET_SECONDS;
  const reset = /reset in (\d+)\s*(minute|hour)/i.exec(tail);
  if (executor === "devin" && reset?.[1] !== undefined) {
    seconds = Number(reset[1]) * (/^h/i.test(reset[2] ?? "") ? 3600 : 60);
  }
  return Math.floor(nowMs / 1000) + seconds;
}

/**
 * Файл ограничений: каталог 0700, файл 0600, одна строка; запись через
 * временный файл рядом и rename.
 */
export async function writeLimitFile(
  directory: string,
  executor: Executor,
  epoch: number,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = path.join(directory, executor);
  const temporary = `${target}.tmp-${String(process.pid)}`;
  try {
    await writeFile(temporary, `${String(epoch)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM своей группе, до 5 с ожидания, затем SIGKILL ей же.
 * Сигналы только `-pgid` группы, созданной этим сторожем.
 */
async function stopGroup(pgid: number): Promise<void> {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + TERM_GRACE_MS;
  while (isGroupAlive(pgid) && Date.now() < deadline) await sleep(100);
  if (!isGroupAlive(pgid)) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // группа уже завершилась
  }
}

interface Sample {
  cpu: number;
  children: string;
  log: number;
  file: number;
}

async function sampleSignals(
  pgid: number,
  watchFile: string | undefined,
): Promise<Sample> {
  // Вся группа процессов, включая фоновые `&`, пережившие своего родителя.
  const list = await listProcesses();
  const kids = list.filter((p) => p.pgid === pgid);
  const cpu = await cpuTimeSum(kids.map((kid) => kid.pid));
  const children = kids
    .map((kid) => kid.pid)
    .toSorted((a, b) => a - b)
    .join(",");
  let log = 0;
  const acp = kids.find((kid) => isDevinAcp(kid.command));
  if (acp !== undefined) {
    const logsDirectory = path.join(
      homedir(),
      ".local",
      "share",
      "devin",
      "cli",
      "logs",
    );
    const found = await findAcpLog(logsDirectory, acp.pid);
    log = found?.mtimeMs ?? 0;
  }
  let file = 0;
  if (watchFile !== undefined) {
    try {
      const info = await stat(watchFile);
      file = info.size;
    } catch {
      // файла пока нет
    }
  }
  return { cpu, children, log, file };
}

/**
 * Запуск и надзор; возвращает код выхода сторожа.
 */
async function runWatchdog(arguments_: WatchdogArguments): Promise<number> {
  const [binary, ...rest] = arguments_.command;
  if (binary === undefined) return 2;
  const executor = detectExecutor(arguments_.command);
  const started = Date.now();
  const child = spawn(binary, rest, {
    detached: true,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const pgid = child.pid;
  const state: {
    stop?: "silence" | "ceiling";
    isFinished: boolean;
    isNewlineEnded: boolean;
    isAbandoned: boolean;
  } = { isFinished: false, isNewlineEnded: true, isAbandoned: false };
  const isDone = (): boolean => state.isFinished;
  let lastSignal = started;
  let tail = Buffer.alloc(0);
  const forward =
    (target: NodeJS.WriteStream, isStdout: boolean) => (chunk: Buffer) => {
      lastSignal = Date.now();
      tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);
      target.write(chunk);
      if (isStdout)
        state.isNewlineEnded = chunk.subarray(-1).toString() === "\n";
    };
  child.stdout.on("data", forward(process.stdout, true));
  child.stderr.on("data", forward(process.stderr, false));
  // Потребитель закрыл канал (`| head`): пишем уже некуда — гасим группу.
  const abandon = (): void => {
    state.isAbandoned = true;
  };
  process.stdout.on("error", abandon);
  process.stderr.on("error", abandon);

  const exit = new Promise<{ code: number; spawnError?: string }>((resolve) => {
    child.on("error", (error) => {
      resolve({ code: 127, spawnError: error.message });
    });
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? 128 + (signal === null ? 1 : constants.signals[signal]),
      });
    });
  });

  const forwardSignal = (signal: NodeJS.Signals) => () => {
    if (pgid !== undefined) {
      try {
        process.kill(-pgid, signal);
      } catch {
        // группа уже завершилась
      }
    }
  };
  const onTerm = forwardSignal("SIGTERM");
  const onInterrupt = forwardSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInterrupt);

  let previous: Sample | undefined;
  try {
    previous = await sampleSignals(pgid ?? 0, arguments_.watchFile);
  } catch {
    // сбой ps — первая проба будет опорной
  }
  let lastSample = Date.now();
  let stopText = "";
  void exit.then(() => {
    state.isFinished = true;
  });
  // Надзор идёт, пока жива вся группа: фоновые `&` переживают свою оболочку.
  while (pgid !== undefined && (!isDone() || isGroupAlive(pgid))) {
    await sleep(TICK_MS);
    if (state.isAbandoned) {
      await stopGroup(pgid);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInterrupt);
      await exit;
      return 141;
    }
    if (Date.now() - lastSample >= POLL_MS) {
      lastSample = Date.now();
      try {
        const sample = await sampleSignals(pgid, arguments_.watchFile);
        if (
          previous !== undefined &&
          (sample.cpu > previous.cpu ||
            sample.children !== previous.children ||
            sample.log > previous.log ||
            sample.file > previous.file)
        ) {
          lastSignal = Date.now();
        }
        previous = sample;
      } catch {
        // сбой ps — не сигнал и не повод останавливать
      }
    }
    const now = Date.now();
    if (
      arguments_.maxSeconds !== undefined &&
      now - started > arguments_.maxSeconds * 1000
    ) {
      state.stop = "ceiling";
      stopText = "потолок";
    } else if (now - lastSignal > arguments_.silence * 1000) {
      state.stop = "silence";
      stopText = `тишина ${String(Math.round((now - lastSignal) / 1000))} с`;
    }
    if (state.stop !== undefined) {
      if (!state.isNewlineEnded) process.stdout.write("\n");
      process.stdout.write(`WATCHDOG: остановлен: ${stopText}\n`);
      state.isNewlineEnded = true;
      await stopGroup(pgid);
      break;
    }
  }
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInterrupt);
  if (state.stop !== undefined) {
    // потомок вне группы (setsid) может держать канал вывода: не ждём его вечно
    await Promise.race([exit, sleep(1000)]);
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const result = await exit;
  if (result.spawnError !== undefined) {
    process.stderr.write(
      `WATCHDOG: не удалось запустить: ${result.spawnError}\n`,
    );
  }
  if (!state.isNewlineEnded) process.stdout.write("\n");

  if (state.stop !== undefined || result.code !== 0) {
    const epoch = findRateLimit(tail.toString("utf8"), executor, Date.now());
    if (epoch !== undefined) {
      if (executor !== undefined) {
        try {
          await writeLimitFile(
            path.join(homedir(), ".local", "state", "executor-limits"),
            executor,
            epoch,
          );
        } catch (error) {
          process.stderr.write(
            `WATCHDOG: файл ограничений не записан: ${String(error)}\n`,
          );
        }
      }
      process.stdout.write(`RATE_LIMIT ${String(epoch)}\n`);
      return 75;
    }
  }
  if (state.stop !== undefined) {
    process.stdout.write(`STALLED ${state.stop}\n`);
    return 76;
  }
  process.stdout.write(`DONE ${String(result.code)}\n`);
  return result.code === 75 || result.code === 76 ? 1 : result.code;
}

if (import.meta.main) {
  try {
    process.exitCode = await runWatchdog(
      parseWatchdogArguments(process.argv.slice(2)),
    );
  } catch (error) {
    process.stderr.write(
      `watchdog: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
