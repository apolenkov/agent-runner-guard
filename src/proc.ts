/**
 * Помощники для работы с процессами: ps, lsof, дерево потомков,
 * распознавание проверок (vitest, tsc, …) в командных строках.
 * Все процессы запускаются через execFile без shell.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Строка ps: pid, ppid, pgid (группа процессов), возраст в секундах, состояние (stat; «Z» —
 * зомби) и командная строка.
 */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  etimeSeconds: number;
  stat?: string;
  command: string;
}

/**
 * Запуск команды без shell; резолвится stdout/stderr, при ненулевом
 * коде выхода — ошибка.
 */
const execFileAsync = promisify(execFile);

export async function run(
  command: string,
  commandArguments: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, commandArguments, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Все процессы системы: `ps -axo pid=,ppid=,pgid=,etime=,stat=,command=`.
 */
export async function listProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await run("ps", [
    "-axo",
    "pid=,ppid=,pgid=,etime=,stat=,command=",
  ]);
  return parsePsList(stdout);
}

/**
 * Разбор вывода `ps -axo pid=,ppid=,pgid=,etime=,stat=,command=` (etime —
 * [[дни-]часы:]минуты:секунды).
 * @internal Экспорт для тестов.
 */
export function parsePsList(output: string): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*\S)\s*$/.exec(
      line,
    );
    if (
      match?.[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined ||
      match[4] === undefined ||
      match[5] === undefined ||
      match[6] === undefined
    ) {
      continue;
    }
    result.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      etimeSeconds: parseEtime(match[4]),
      stat: match[5],
      command: match[6],
    });
  }
  return result;
}

function parseEtime(etime: string): number {
  const [daysText, clockText] = etime.includes("-")
    ? etime.split("-", 2)
    : ["0", etime];
  let seconds = 0;
  const clockParts = (clockText ?? "").split(":");
  for (const part of clockParts) {
    seconds = seconds * 60 + Number(part);
  }
  return Number(daysText) * 86_400 + seconds;
}

/**
 * Рабочий каталог процесса через `lsof -a -p PID -d cwd -Fn`;
 * процесса нет или каталог неизвестен → undefined.
 */
export async function cwdOf(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await run("lsof", [
      "-a",
      "-p",
      String(pid),
      "-d",
      "cwd",
      "-Fn",
    ]);
    const line = stdout.split("\n").find((l) => l.startsWith("n"));
    if (line === undefined || line.length < 2) return undefined;
    return line.slice(1);
  } catch {
    return undefined;
  }
}

/**
 * Потомки pid внутри готового списка процессов (порядок — по уровням).
 */
export function descendantsOf(list: ProcessInfo[], pid: number): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const item of list) {
    const siblings = byParent.get(item.ppid);
    if (siblings === undefined) {
      byParent.set(item.ppid, [item]);
    } else {
      siblings.push(item);
    }
  }
  const result: ProcessInfo[] = [];
  const queue = [...(byParent.get(pid) ?? [])];
  let cursor = 0;
  while (cursor < queue.length) {
    const item = queue[cursor];
    cursor += 1;
    if (item === undefined) continue;
    result.push(item);
    const children = byParent.get(item.pid) ?? [];
    for (const child of children) queue.push(child);
  }
  return result;
}

const CHECK_PATTERN =
  /\b(vitest|tsc|eslint|knip|ls-lint|prettier|gitleaks|openspec|pnpm)\b/g;

/**
 * Имена идущих проверок по командным строкам потомков
 * (vitest|tsc|eslint|knip|ls-lint|prettier|gitleaks|openspec|pnpm),
 * уникальные, в порядке встречаемости.
 */
export function checkNames(commands: string[]): string[] {
  const found = new Set<string>();
  for (const command of commands) {
    for (const match of command.matchAll(CHECK_PATTERN)) {
      const name = match[1];
      if (name !== undefined) found.add(name);
    }
  }
  return [...found];
}
