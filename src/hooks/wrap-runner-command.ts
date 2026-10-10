/**
 * Хук Claude Code PreToolUse (Bash): команды `devin -p`, `pi -p` и
 * `codex exec` оборачиваются в сторож запусков (`src/watchdog.ts`) через
 * `updatedInput`; к `pi -p` добавляется расширение `src/harness/pi-alert.ts`.
 * JSON со стандартного ввода → JSON со стандартного вывода. Хук никогда не
 * блокирует: любой сбой, чужая команда или отсутствие сторожа → пустой
 * вывод и код 0 (команда идёт как есть).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeShell } from "../shell-command.ts";

/** Literal effective stdout destination of the first supported runner. */
export function outputFileOf(
  command: string,
  cwd?: string,
): string | undefined {
  return analyzeShell(command, cwd).runners[0]?.outputFile;
}

/**
 * Ответ хука для входного JSON; пустая строка — ничего не менять.
 * @param watchdogPath абсолютный путь к `watchdog.ts`; нет файла — не оборачивать.
 */
export function wrapRunnerCommand(input: string, watchdogPath: string): string {
  try {
    const event: unknown = JSON.parse(input);
    if (typeof event !== "object" || event === null) return "";
    const {
      tool_name: toolName,
      tool_input: toolInput,
      cwd,
    } = event as Record<string, unknown>;
    if (toolName !== "Bash") return "";
    if (typeof toolInput !== "object" || toolInput === null) return "";
    const command = (toolInput as Record<string, unknown>)["command"];
    if (typeof command !== "string") return "";
    const analysis = analyzeShell(
      command,
      typeof cwd === "string" ? cwd : undefined,
    );
    const runners = analysis.runners.filter(
      (runner) => runner.executor !== "pi" || runner.argv.includes("-p"),
    );
    if (runners.length === 0) return "";
    if (!existsSync(watchdogPath)) return "";
    // Передний план обрывается таймаутом Bash-инструмента раньше порога
    // тишины: сторож должен остановить группу и записать итог до него.
    const { timeout, run_in_background: isBackground } = toolInput as Record<
      string,
      unknown
    >;
    // Без явного timeout Bash-инструмент в переднем плане обрывает команду на 120 с.
    // Фон обрывается таймаутом Bash так же (по умолчанию 30 минут).
    const fallbackMs = isBackground === true ? 1_800_000 : 120_000;
    const timeoutMs =
      typeof timeout === "number" && timeout > 0 ? timeout : fallbackMs;
    // Недостаточный бюджет проходит без сторожа и без расширения Pi.
    if (!Number.isFinite(timeoutMs)) return "";
    const maxSeconds = Math.floor(timeoutMs / 1000 - 15);
    if (maxSeconds < 1) return "";
    const limit = ` --max-seconds ${String(maxSeconds)}`;
    // Pi: расширение сообщает сторожу об ошибке/лимите (alert-файл)
    const extension = path.join(
      path.dirname(watchdogPath),
      "harness",
      "pi-alert.ts",
    );
    // `<<` где угодно (heredoc, комментарии с кавычками) — не разбираем:
    // испортить тело heredoc хуже, чем остаться без расширения
    const pi = runners.find((candidate) => candidate.executor === "pi");
    const runner =
      existsSync(extension) &&
      !command.includes("<<") &&
      pi?.nameEnd !== undefined
        ? `${command.slice(0, pi.nameEnd)} -e '${extension.replaceAll("'", String.raw`'\''`)}'${command.slice(pi.nameEnd)}`
        : command;
    const quoted = runner.replaceAll("'", String.raw`'\''`);
    // вывод уходит в файл — сторож смотрит в него: рост — жизнь, хвост — лимит
    const outputFile = runners[0]?.outputFile;
    const watch =
      outputFile === undefined
        ? ""
        : ` --watch-file '${outputFile.replaceAll("'", String.raw`'\''`)}'`;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          ...toolInput,
          command: `node '${watchdogPath.replaceAll("'", String.raw`'\''`)}' --silence 600${limit}${watch} -- bash -c '${quoted}'`,
        },
      },
    });
  } catch {
    return "";
  }
}

if (import.meta.main) {
  let output = "";
  try {
    output = wrapRunnerCommand(
      readFileSync(0, "utf8"),
      fileURLToPath(new URL("../watchdog.ts", import.meta.url)),
    );
  } catch {
    // не блокируем
  }
  if (output !== "") process.stdout.write(output);
  process.exitCode = 0;
}
