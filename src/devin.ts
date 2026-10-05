/**
 * Процессные хелперы сторожа: какой исполнитель запущен командой, журнал
 * `devin acp` и процессорное время дерева. Извлечено из agent-viewer
 * (sources/devin-process.ts) без изменения поведения.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { run } from "./proc.ts";

export type Executor = "devin" | "pi" | "codex";

export function executorOf(command: string): Executor | undefined {
  const tokens = command.split(/\s+/);
  const binary = path.basename(tokens[0] ?? "");
  if (binary === "devin" && tokens.slice(1).includes("-p")) return "devin";
  if (binary === "pi") return "pi";
  return binary === "codex" && isCodexExec(tokens) ? "codex" : undefined;
}

/**
 * Глобальные опции codex со значением в следующем токене.
 */
const CODEX_OPTION_WITH_VALUE = new Set([
  "-c",
  "--config",
  "-m",
  "--model",
  "-p",
  "--profile",
]);

/**
 * `codex [глобальные опции] exec …`: перед субкомандой пропускаем опции —
 * известные со значением (-c k=v, -m X, -p X и длинные формы), прочие
 * -x/--x без значения.
 */
function isCodexExec(tokens: string[]): boolean {
  let index = 1;
  while ((tokens[index] ?? "").startsWith("-")) {
    index += CODEX_OPTION_WITH_VALUE.has(tokens[index] ?? "") ? 2 : 1;
  }
  return tokens[index] === "exec";
}

/**
 * Свежий по mtime журнал devin_*_<pid acp>.log в каталоге; нет — undefined.
 * Используется сторожем запусков.
 */
export async function findAcpLog(
  logsDirectory: string,
  acpPid: number,
): Promise<{ file: string; mtimeMs: number } | undefined> {
  let names: string[];
  try {
    names = await readdir(logsDirectory);
  } catch {
    return undefined;
  }
  const suffix = `_${String(acpPid)}.log`;
  let best: { file: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.startsWith("devin_") || !name.endsWith(suffix)) continue;
    const file = path.join(logsDirectory, name);
    try {
      const info = await stat(file);
      if (best === undefined || info.mtimeMs > best.mtimeMs) {
        best = { file, mtimeMs: info.mtimeMs };
      }
    } catch {
      continue;
    }
  }
  return best;
}

/**
 * Команда — `devin acp`.
 * Используется сторожем запусков.
 */
export function isDevinAcp(command: string): boolean {
  const tokens = command.split(/\s+/);
  return path.basename(tokens[0] ?? "") === "devin" && tokens[1] === "acp";
}

/**
 * Сумма `ps -o time=` для pid дерева (формат [[дни-]часы:]мин:сек.доли).
 * Используется сторожем запусков.
 */
export async function cpuTimeSum(pids: number[]): Promise<number> {
  if (pids.length === 0) return 0;
  try {
    const { stdout } = await run("ps", ["-o", "time=", "-p", pids.join(",")]);
    let total = 0;
    for (const line of stdout.split("\n")) {
      const text = line.trim();
      if (text !== "") total += parseCpuTime(text);
    }
    return total;
  } catch {
    return 0;
  }
}

function parseCpuTime(text: string): number {
  const [mainPart, fractionPart] = text.split(".", 2);
  const [daysPart, clockPart] = (mainPart ?? "").includes("-")
    ? (mainPart ?? "").split("-", 2)
    : ["0", mainPart];
  let seconds = 0;
  const clockParts = (clockPart ?? "").split(":");
  for (const part of clockParts) {
    seconds = seconds * 60 + Number(part);
  }
  const fraction = fractionPart === undefined ? 0 : Number(`0.${fractionPart}`);
  return Number(daysPart) * 86_400 + seconds + fraction;
}
