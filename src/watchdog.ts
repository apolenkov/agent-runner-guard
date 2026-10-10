/**
 * Сторож запусков Devin, Pi и Codex: `node src/watchdog.ts [--silence <сек>]
 * [--max-seconds <сек>] [--watch-file <путь>] -- <команда> [аргументы…]`.
 * Запускает команду в своей группе процессов, пробрасывает вывод, раз в
 * 2 с ищет признаки жизни; при тишине или превышении потолка останавливает
 * ТОЛЬКО свою группу. Та же задача при живом первом запуске не стартует:
 * замок <executor-limits>/locks/<sha256 идентичности> — исполнитель +
 * prompt-файл, иначе исполнитель + реальный cwd + команда без редиректов; внутри — pgid
 * группы, pid сторожа и файл вывода; замок жив, пока жива группа или сторож.
 * Живые события (лимит, отказ инструмента — по строкам вывода и
 * `--watch-file`; события хуков харнессов — по alert-файлу, путь в env
 * HARNESS_ALERT_FILE) останавливают группу сразу, не дожидаясь выхода.
 * Последняя строка stdout: DONE <код> | RATE_LIMIT <epoch> |
 * STALLED <silence|ceiling> | BUSY <pid> <файл вывода> | WAITING <что> |
 * FAILED <почему>.
 * Коды выхода: код команды (75–79 → 1), 75 — лимит, 76 — зависание,
 * 77 — та же задача уже идёт, 78 — ждёт ввода/отказ, 79 — ошибка харнесса.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants, homedir } from "node:os";
import path from "node:path";

import { cpuTimeSum, type Executor, findAcpLog, isDevinAcp } from "./devin.ts";
import { mask } from "./mask.ts";
import { listProcesses } from "./proc.ts";
import { analyzeCommand, promptPath } from "./shell-command.ts";

const TAIL_BYTES = 64 * 1024;
const POLL_MS = 2000;
const TICK_MS = 200;
const TERM_GRACE_MS = 5000;
// по событию ждём меньше: итог — за ~5 с от события
const EVENT_GRACE_MS = 2000;
const DEFAULT_SILENCE = 600;
const DEFAULT_RESET_SECONDS = 30 * 60;
// Devin: «quota» бывает в обычном коде, поэтому ищем только его формулировку.
const DEVIN_LIMIT_PATTERN =
  /Reached free model rate limit|too many requests|\b429\b/i;
// Codex — свои фразы целиком: usage.?limit ловит идентификаторы в коде.
const CODEX_LIMIT_PATTERN =
  /you've hit your usage limit|you hit your spend cap|usage limit (?:reached|exceeded)|RateLimitReached|usage_limit_reached|\busage_limited\b|too many requests|\b429\b/i;
const OTHER_LIMIT_PATTERN = /rate.?limit|too many requests|\b429\b|quota/i;
const LIMIT_PATTERN: Record<Executor, RegExp> = {
  codex: CODEX_LIMIT_PATTERN,
  devin: DEVIN_LIMIT_PATTERN,
  pi: OTHER_LIMIT_PATTERN,
};
const BUSY_CODE = 77;
const WAITING_CODE = 78;
const FAILED_CODE = 79;
const MESSAGE_CHARS = 120;

const ALERT_TYPES = ["rate_limit", "waiting", "error"] as const;
type AlertType = (typeof ALERT_TYPES)[number];

function isAlertType(value: unknown): value is AlertType {
  return (ALERT_TYPES as readonly unknown[]).includes(value);
}

interface HarnessEvent {
  type: AlertType;
  message: string;
}

// Живые шаблоны: с начала строки и полной формулировкой самого харнесса —
// рабочий текст раннера (дифф, вывод cat) их не даёт. Pi сообщает о
// событиях через расширение (alert-файл), своих шаблонов у него нет.
const LIVE_PATTERNS: Partial<Record<Executor, [AlertType, RegExp][]>> = {
  devin: [
    ["rate_limit", /^(?:Error:\s*)?Reached free model rate limit/m],
    [
      "waiting",
      /^warning: rejected a tool call that requires confirmation\. Running in non-interactive mode/m,
    ],
  ],
  // Живой текст Codex 0.160.0 (2026-10-05): «ERROR: You hit your spend cap set by the
  // owner of your workspace. …»; усечённый «usage limit» — по документации, живьём не видели.
  codex: [
    [
      "rate_limit",
      /^(?:\[[^\]\n]*\]\s*)?ERROR:?\s[^\n]*(?:hit your (?:usage limit|spend cap)|usage_limit_reached)/im,
    ],
  ],
};
export interface WatchdogArguments {
  silence: number;
  maxSeconds: number | undefined;
  watchFile?: string;
  alertFile?: string;
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
    if (name === "--watch-file" || name === "--alert-file") {
      // alert-файл — абсолютный: команда может сменить каталог
      if (name === "--watch-file") result.watchFile = value;
      else result.alertFile = path.resolve(value);
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
  return analyzeCommand(command, process.cwd()).runners[0]?.executor;
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
    executor === undefined ? OTHER_LIMIT_PATTERN : LIMIT_PATTERN[executor];
  if (!pattern.test(tail)) return undefined;
  // ponytail: сброс по умолчанию; брать время из сообщения Codex, если появится
  let seconds = DEFAULT_RESET_SECONDS;
  const reset = /reset in (\d+)\s*(minute|hour)/i.exec(tail);
  if (executor === "devin" && reset?.[1] !== undefined) {
    seconds = Number(reset[1]) * (/^h/i.test(reset[2] ?? "") ? 3600 : 60);
  }
  return Math.floor(nowMs / 1000) + seconds;
}

/**
 * Одна строка для вердикта: без управляющих символов, не длиннее
 * MESSAGE_CHARS.
 */
function oneLine(text: string): string {
  return mask(text)
    .replaceAll(/[\u{0}-\u{1F}\u{7F}]+/gu, " ")
    .trim()
    .slice(0, MESSAGE_CHARS);
}

/**
 * Живое событие в выводе: только завершённые строки; у окна, обрезанного
 * спереди, первая (неполная) строка отбрасывается. Нет — undefined.
 */
export function liveEvent(
  text: string,
  executor: Executor | undefined,
  isTruncated = false,
): HarnessEvent | undefined {
  const end = text.lastIndexOf("\n");
  if (executor === undefined || end === -1) return undefined;
  const start = isTruncated ? text.indexOf("\n") + 1 : 0;
  const complete = text.slice(start, end + 1);
  const patterns = LIVE_PATTERNS[executor] ?? [];
  for (const [type, pattern] of patterns) {
    const match = pattern.exec(complete);
    if (match !== null) {
      const line = complete.slice(match.index).split("\n", 1)[0] ?? "";
      return { type, message: line };
    }
  }
  return undefined;
}

/**
 * Первое распознанное событие в тексте alert-файла (JSONL от хуков);
 * битые строки и неизвестные типы пропускаются. Нет — undefined.
 */
function alertEvent(text: string): HarnessEvent | undefined {
  for (const line of text.split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const { type, message } = value as Record<string, unknown>;
    if (isAlertType(type)) {
      return {
        type,
        message: typeof message === "string" ? message : type,
      };
    }
  }
  return undefined;
}

interface FileMark {
  size: number;
  edge: Buffer;
  identity?: string;
}

const EDGE_BYTES = 64;
// alert-файл читается целиком (JSON-строку нельзя резать), но с потолком
const ALERT_BYTES = 1024 * 1024;

/**
 * Отметка файла до запуска: идентичность, размер и последние байты перед
 * ним — по ним дописывание (`>>`) отличается от перезаписи (`>`).
 * Нет файла — пусто.
 */
async function markOf(file: string | undefined): Promise<FileMark> {
  const empty = { size: 0, edge: Buffer.alloc(0) };
  if (file === undefined) return empty;
  try {
    // FIFO и прочие нерегулярные файлы не открываем: open ждал бы писателя
    const info = await stat(file);
    if (!info.isFile()) return empty;
    const handle = await open(file, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return empty;
      const { size, dev, ino } = opened;
      const edge = Buffer.alloc(Math.min(EDGE_BYTES, size));
      await handle.read(edge, 0, edge.length, size - edge.length);
      return { size, edge, identity: `${String(dev)}:${String(ino)}` };
    } finally {
      await handle.close();
    }
  } catch {
    return empty;
  }
}

/**
 * Новое в файле после отметки до запуска (прошлый вывод `>>` не событие;
 * файл стал короче отметки или сменились её края — перезаписан, отметка
 * сбрасывается в 0 навсегда), не больше `limit` байт с конца; замена файла
 * также сбрасывает отметку. Обрезанное спереди окно теряет неполную первую
 * строку. undefined — идентичность, размер и метаданные изменения не
 * менялись с прошлого чтения (`seen`); это не гарантированная версия текста.
 */
async function readNew(
  file: string | undefined,
  mark: FileMark,
  seen: Map<string, string>,
  limit = TAIL_BYTES,
): Promise<string | undefined> {
  if (file === undefined) return undefined;
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined; // FIFO: open ждал бы писателя
    const handle = await open(file, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return undefined;
      const { size, dev, ino, mtimeMs, ctimeMs } = opened;
      const identity = `${String(dev)}:${String(ino)}`;
      const revision = `${identity}:${String(size)}:${String(mtimeMs)}:${String(ctimeMs)}`;
      if (seen.get(file) === revision) return undefined;
      if (mark.identity !== undefined && identity !== mark.identity)
        mark.size = 0;
      if (size < mark.size) mark.size = 0; // `>` перезаписал: дальше — всё новое
      if (mark.size > 0) {
        const edge = Buffer.alloc(mark.edge.length);
        await handle.read(edge, 0, edge.length, mark.size - edge.length);
        if (!edge.equals(mark.edge)) mark.size = 0;
      }
      // ponytail: перезапись тем же текстом длиннее старого быстрее тика
      // (200 мс) неотличима от дописывания; настоящие раннеры пишут через секунды
      const base = mark.size;
      const start = Math.max(base, size - limit);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      seen.set(file, revision);
      return start > base ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Alert-файл по умолчанию: <executor-limits>/alerts/<pid>-<uuid>.jsonl,
 * каталог 0700, пустой файл 0600. Удаляет вызывающий.
 */
async function createAlertFile(): Promise<string> {
  const directory = path.join(limitsDirectory(), "alerts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = path.join(
    directory,
    `${String(process.pid)}-${randomUUID()}.jsonl`,
  );
  await writeFile(file, "", { mode: 0o600, flag: "wx" });
  return file;
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

/**
 * Каталог файлов ограничений и замков:
 * ~/.local/state/executor-limits, переопределяется EXECUTOR_LIMITS_DIR
 * (в тестах — без трюков с HOME).
 */
function limitsDirectory(): string {
  return (
    process.env.EXECUTOR_LIMITS_DIR ??
    path.join(homedir(), ".local", "state", "executor-limits")
  );
}

/**
 * Исполнитель + полный literal prompt-файл, иначе cwd + argv; AST удаляет
 * только настоящие shell-редиректы из запасной идентичности.
 */
function lockIdentity(
  command: string[],
  executor: Executor | undefined,
): string {
  const analysis = analyzeCommand(command, process.cwd());
  const prompt = promptPath(analysis.runners[0]);
  if (prompt !== undefined) return `${executor ?? "-"}|file:${prompt}`;
  return `${executor ?? "-"}|cwd:${realpathSync(process.cwd())}|cmd:${JSON.stringify(analysis.normalized)}`;
}

/**
 * Файл замка команды в каталоге замков: sha256 идентичности запуска.
 * @internal Экспорт для тестов.
 */
export function runLockFile(
  command: string[],
  directory: string,
  executor?: Executor,
): string {
  const key = createHash("sha256")
    .update(lockIdentity(command, executor))
    .digest("hex");
  return path.join(directory, key);
}

interface LockContent {
  pgid: number | undefined;
  pid: number | undefined;
  output: string;
}

/**
 * Положительное целое из строки замка, иначе undefined.
 */
function lockNumber(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Замок: «pgid\npid сторожа\nфайл вывода\n» (pgid 0 — до перезаписи после
 * spawn). Нет файла — undefined; пустой/битый — содержимое без pid.
 */
async function readLock(file: string): Promise<LockContent | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const [pgidText, pidText, ...rest] = text.split("\n");
  return {
    pgid: lockNumber(pgidText),
    pid: lockNumber(pidText),
    output: rest.join("\n").trim() || "-",
  };
}

/**
 * Literal stdout-файл первого раннера или последней простой shell-команды;
 * неизвестная цель / отсутствие редиректа — undefined.
 * @internal Экспорт для тестов.
 */
export function outputFileOf(command: string[]): string | undefined {
  const analysis = analyzeCommand(command, process.cwd());
  return analysis.runners[0]?.outputFile ?? analysis.outputFile;
}

/**
 * Жив ли держатель замка: жива его группа (EPERM — есть, прав нет — жив)
 * или жив сам сторож.
 */
function isLockAlive(held: LockContent): boolean {
  return (
    (held.pgid !== undefined && isGroupPresent(held.pgid)) ||
    (held.pid !== undefined && isPidAlive(held.pid))
  );
}

/**
 * Держатель живого замка — для BUSY. Замок пустой или протухший —
 * undefined; между чтениями пауза: файл мог быть только что создан
 * конкурентом и ещё пуст.
 */
async function busyHolder(file: string): Promise<LockContent | undefined> {
  for (let check = 0; check < 2; check += 1) {
    const held = await readLock(file);
    if (held !== undefined && isLockAlive(held)) return held;
    if (check === 0) await sleep(100);
  }
  return undefined;
}

/**
 * Снятие протухшего замка: атомарный rename в уникальное имя — удаётся ровно
 * одному уборщику. Если за это время на месте замка оказался свежий замок
 * нового владельца (его увели вместо протухшего), он возвращается на место
 * через link (без перезаписи), а его владелец отдаётся для BUSY.
 * undefined — протухший замок убран, можно брать.
 */
async function reclaimStale(file: string): Promise<LockContent | undefined> {
  const moved = `${file}.stale-${String(process.pid)}-${randomUUID()}`;
  try {
    await rename(file, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const held = await readLock(moved);
    if (held !== undefined && isLockAlive(held)) {
      try {
        await link(moved, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return held;
    }
    return undefined;
  } finally {
    await rm(moved, { force: true });
  }
}

/**
 * Взятие замка до spawn: O_EXCL — кто создал, тот держит. Внутри сначала
 * только pid сторожа (pgid появится после запуска). Живой чужой замок —
 * его содержимое для BUSY; протухший — сносится, попытка повторяется
 * один раз. undefined — замок наш.
 */
export async function acquireLock(
  file: string,
  output: string,
  inspect = busyHolder,
): Promise<LockContent | undefined> {
  const directory = path.dirname(file);
  const create = async (): Promise<void> => {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(`0\n${String(process.pid)}\n${output}\n`);
    } finally {
      await handle.close();
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await create();
      return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        attempt -= 1; // каталог снесло снятием чужого замка — не гонка
        continue;
      }
      if (code !== "EEXIST") throw error;
      const held = await inspect(file);
      if (held !== undefined) return held;
      // протухший замок снимает ровно один уборщик (rename); чужой свежий не трогаем
      const fresh = await reclaimStale(file);
      if (fresh !== undefined) return fresh;
    }
  }
  // дважды проиграли взятие — команда занята
  return (
    (await readLock(file)) ?? { pgid: undefined, pid: undefined, output: "-" }
  );
}

/**
 * Перезапись замка после spawn с pgid группы — через временный файл
 * рядом и rename (каталог уже создан acquireLock).
 */
async function writeLock(
  file: string,
  pgid: number,
  output: string,
): Promise<void> {
  const temporary = `${file}.tmp-${String(process.pid)}`;
  try {
    await writeFile(
      temporary,
      `${String(pgid)}\n${String(process.pid)}\n${output}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Снятие замка: только если файл всё ещё наш (pid сторожа совпадает) —
 * чужой замок не трогаем. Каталоги подчищаются только внутри базы:
 * сначала locks, затем сама база, если опустела — выше не поднимаемся.
 */
async function releaseLock(file: string): Promise<void> {
  const held = await readLock(file);
  if (held?.pid !== process.pid) return;
  await rm(file, { force: true });
  for (const directory of [
    path.dirname(file),
    path.dirname(path.dirname(file)),
  ]) {
    try {
      await rmdir(directory); // только пустой: чужие файлы не трогаем
    } catch {
      break; // непустой — стоп
    }
  }
}

/**
 * Замок снимаем только за мёртвой группой: пережила остановку — замок
 * остаётся и протухнет по её смерти.
 */
async function releaseIfGone(
  file: string,
  pgid: number | undefined,
): Promise<void> {
  // Только что вышедшая группа исчезает не мгновенно (ожидание reap):
  // даём ей до секунды, иначе под нагрузкой замок оставался зря.
  for (let poll = 0; pgid !== undefined && isGroupPresent(pgid); poll += 1) {
    if (poll >= 10) return;
    await sleep(100);
  }
  await releaseLock(file);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // сигнал 0 — проверка существования, ничего не шлёт
    return true;
  } catch (error) {
    // EPERM — процесс есть, прав на сигнал нет → жив
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Группа существует для замка: хоть один член, включая зомби/чужой
 * (EPERM). Для надзора — isGroupAlive: зомби не признак жизни.
 */
function isGroupPresent(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
async function stopGroup(pgid: number, graceMs = TERM_GRACE_MS): Promise<void> {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + graceMs;
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
  // Замок на идентичность задачи (исполнитель + prompt-файл/команда):
  // координатор перезапускал ту же задачу после STALLED при живом первом
  // процессе или с другим «> файл» — второй не стартует. Взятие O_EXCL
  // до spawn — одновременный старт двух одинаковых исключается.
  const lockFile = runLockFile(
    arguments_.command,
    path.join(limitsDirectory(), "locks"),
    executor,
  );
  const output =
    arguments_.watchFile ?? outputFileOf(arguments_.command) ?? "-";
  const held = await acquireLock(lockFile, output);
  if (held !== undefined) {
    process.stdout.write(
      `BUSY ${String(held.pgid ?? held.pid ?? "-")} ${held.output}\n`,
    );
    return BUSY_CODE;
  }
  const watchFrom = await markOf(arguments_.watchFile);
  const alertFrom = await markOf(arguments_.alertFile);
  // stdin — /dev/null: неинтерактивному раннеру ввод не нужен, а `pi -p`
  // иначе молча висит на чтении stdin Bash-инструмента
  const child = spawn(binary, rest, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env:
      arguments_.alertFile === undefined
        ? process.env
        : { ...process.env, HARNESS_ALERT_FILE: arguments_.alertFile },
  });
  const pgid = child.pid;
  const state: {
    stop?: "silence" | "ceiling" | "event";
    event?: HarnessEvent | undefined;
    isFinished: boolean;
    isNewlineEnded: boolean;
    isAbandoned: boolean;
  } = { isFinished: false, isNewlineEnded: true, isAbandoned: false };
  const isDone = (): boolean => state.isFinished;
  let lastSignal = started;
  // «жёсткий» признак жизни (вывод, файл, процессы, журнал): рост CPU
  // продлевает жизнь не дольше окна тишины после него
  let lastHard = started;
  let tail = Buffer.alloc(0);
  // для живых шаблонов у каждого потока свой хвост: иначе строка stderr
  // теряет начало после stdout без перевода строки
  const streamTails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const forward =
    (target: NodeJS.WriteStream, stream: "stdout" | "stderr") =>
    (chunk: Buffer) => {
      lastSignal = Date.now();
      lastHard = lastSignal;
      tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);
      const own = Buffer.concat([streamTails[stream], chunk]).subarray(
        -TAIL_BYTES,
      );
      streamTails[stream] = own;
      target.write(chunk);
      if (stream === "stdout")
        state.isNewlineEnded = chunk.subarray(-1).toString() === "\n";
      state.event ??= liveEvent(
        own.toString("utf8"),
        executor,
        own.length >= TAIL_BYTES,
      );
    };
  child.stdout.on("data", forward(process.stdout, "stdout"));
  child.stderr.on("data", forward(process.stderr, "stderr"));
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

  if (pgid !== undefined) {
    try {
      await writeLock(lockFile, pgid, output);
    } catch (error) {
      process.stderr.write(`WATCHDOG: замок не записан: ${String(error)}\n`);
    }
  }

  let previous: Sample | undefined;
  try {
    previous = await sampleSignals(pgid ?? 0, arguments_.watchFile);
  } catch {
    // сбой ps — первая проба будет опорной
  }
  let lastSample = Date.now();
  let stopText = "";
  const revisions = new Map<string, string>();
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
      await releaseIfGone(lockFile, pgid);
      return 141;
    }
    // ??= после await: событие из потока, пришедшее во время чтения, не теряется
    const watched = await readNew(arguments_.watchFile, watchFrom, revisions);
    if (watched !== undefined) state.event ??= liveEvent(watched, executor);
    const alerted = await readNew(
      arguments_.alertFile,
      alertFrom,
      revisions,
      ALERT_BYTES,
    );
    if (alerted !== undefined) state.event ??= alertEvent(alerted);
    if (Date.now() - lastSample >= POLL_MS) {
      lastSample = Date.now();
      try {
        const sample = await sampleSignals(pgid, arguments_.watchFile);
        const now = Date.now();
        if (
          previous !== undefined &&
          (sample.children !== previous.children ||
            sample.log > previous.log ||
            sample.file > previous.file)
        ) {
          lastSignal = now;
          lastHard = now;
        } else if (
          previous !== undefined &&
          sample.cpu > previous.cpu &&
          now - lastHard <= arguments_.silence * 1000
        ) {
          lastSignal = now;
        }
        previous = sample;
      } catch {
        // сбой ps — не сигнал и не повод останавливать
      }
    }
    const now = Date.now();
    if (state.event !== undefined) {
      state.stop = "event";
      stopText = `событие: ${state.event.type}: ${oneLine(state.event.message)}`;
    } else if (
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
      process.stdout.write(
        state.stop === "event"
          ? `WATCHDOG: ${stopText}\n`
          : `WATCHDOG: остановлен: ${stopText}\n`,
      );
      state.isNewlineEnded = true;
      await stopGroup(
        pgid,
        state.stop === "event" ? EVENT_GRACE_MS : TERM_GRACE_MS,
      );
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

  // Вывод мог уйти в файл: финальные события и лимит берём только после
  // отметки этого запуска. exit=N — диагностика вложенной команды;
  // результат supplied command всегда остаётся result.code.
  const fileTail =
    (await readNew(arguments_.watchFile, watchFrom, new Map())) ?? "";
  // финальная проверка: событие могло прийти перед самым выходом
  const event =
    state.event ??
    liveEvent(
      `${streamTails.stdout.toString("utf8")}\n`,
      executor,
      streamTails.stdout.length >= TAIL_BYTES,
    ) ??
    liveEvent(
      `${streamTails.stderr.toString("utf8")}\n`,
      executor,
      streamTails.stderr.length >= TAIL_BYTES,
    ) ??
    liveEvent(`${fileTail}\n`, executor) ??
    alertEvent(
      (await readNew(
        arguments_.alertFile,
        alertFrom,
        new Map(),
        ALERT_BYTES,
      )) ?? "",
    );
  const reportLimit = async (epoch: number): Promise<number> => {
    if (executor !== undefined) {
      try {
        await writeLimitFile(limitsDirectory(), executor, epoch);
      } catch (error) {
        process.stderr.write(
          `WATCHDOG: файл ограничений не записан: ${String(error)}\n`,
        );
      }
    }
    process.stdout.write(`RATE_LIMIT ${String(epoch)}\n`);
    await releaseIfGone(lockFile, pgid);
    return 75;
  };
  if (event?.type === "rate_limit") {
    return reportLimit(
      findRateLimit(event.message, executor, Date.now()) ??
        Math.floor(Date.now() / 1000) + DEFAULT_RESET_SECONDS,
    );
  }
  if (event !== undefined) {
    const isWaiting = event.type === "waiting";
    process.stdout.write(
      `${isWaiting ? "WAITING" : "FAILED"} ${oneLine(event.message)}\n`,
    );
    await releaseIfGone(lockFile, pgid);
    return isWaiting ? WAITING_CODE : FAILED_CODE;
  }
  const fileCode = /(?:^|\n)exit=(\d+)\s*$/.exec(fileTail)?.[1];
  const hasFailed =
    result.code !== 0 || (fileCode !== undefined && fileCode !== "0");
  if (hasFailed || state.stop !== undefined) {
    const epoch = findRateLimit(
      `${tail.toString("utf8")}\n${fileTail}`,
      executor,
      Date.now(),
    );
    if (epoch !== undefined) return reportLimit(epoch);
  }
  if (state.stop !== undefined) {
    process.stdout.write(`STALLED ${state.stop}\n`);
    await releaseIfGone(lockFile, pgid);
    return 76;
  }
  process.stdout.write(`DONE ${String(result.code)}\n`);
  await releaseLock(lockFile);
  return [75, 76, BUSY_CODE, WAITING_CODE, FAILED_CODE].includes(result.code)
    ? 1
    : result.code;
}

if (import.meta.main) {
  let ownAlertFile: string | undefined;
  try {
    const arguments_ = parseWatchdogArguments(process.argv.slice(2));
    if (arguments_.alertFile === undefined) {
      try {
        ownAlertFile = await createAlertFile();
        arguments_.alertFile = ownAlertFile;
      } catch (error) {
        process.stderr.write(
          `WATCHDOG: alert-файл не создан: ${String(error)}\n`,
        );
      }
    }
    process.exitCode = await runWatchdog(arguments_);
  } catch (error) {
    process.stderr.write(
      `watchdog: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  } finally {
    if (ownAlertFile !== undefined) {
      await rm(ownAlertFile, { force: true });
      // как у замков: только пустые каталоги и не выше базы
      for (const directory of [path.dirname(ownAlertFile), limitsDirectory()]) {
        try {
          await rmdir(directory);
        } catch {
          break; // чужие файлы идущих запусков
        }
      }
    }
  }
}
