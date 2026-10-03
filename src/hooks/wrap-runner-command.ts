/**
 * Хук Claude Code PreToolUse (Bash): команды `devin -p` и `pi -p`
 * оборачиваются в сторож запусков (`src/watchdog.ts`) через `updatedInput`.
 * JSON со стандартного ввода → JSON со стандартного вывода. Хук никогда не
 * блокирует: любой сбой, чужая команда или отсутствие сторожа → пустой
 * вывод и код 0 (команда идёт как есть).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUNNER = /(?<![\w-])(?:devin|pi)\s+-p(?!\w)/;

/**
 * Куда команда отправляет вывод исполнителя: первая перенаправленная
 * в файл стандартная выдача (`> f`, `>> f`, `1> f`, в кавычках или без)
 * после `devin -p`/`pi -p`. Нет — undefined (вывод и так виден сторожу).
 */
export function outputFileOf(command: string): string | undefined {
  const start = RUNNER.exec(command)?.index ?? 0;
  const redirect =
    /(?:^|[\s;])1?>>?\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|<>]+))/.exec(
      command.slice(start),
    );
  const target = redirect?.[1] ?? redirect?.[2] ?? redirect?.[3];
  if (target === undefined || target.startsWith("&")) return undefined;
  return target === "/dev/null" ? undefined : target;
}

/**
 * Ответ хука для входного JSON; пустая строка — ничего не менять.
 * @param watchdogPath абсолютный путь к `watchdog.ts`; нет файла — не оборачивать.
 */
export function wrapRunnerCommand(input: string, watchdogPath: string): string {
  try {
    const event: unknown = JSON.parse(input);
    if (typeof event !== "object" || event === null) return "";
    const { tool_name: toolName, tool_input: toolInput } = event as Record<
      string,
      unknown
    >;
    if (toolName !== "Bash") return "";
    if (typeof toolInput !== "object" || toolInput === null) return "";
    const command = (toolInput as Record<string, unknown>)["command"];
    if (typeof command !== "string" || !RUNNER.test(command)) return "";
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
    const limit = ` --max-seconds ${String(Math.max(30, Math.floor(timeoutMs / 1000 - 15)))}`;
    const quoted = command.replaceAll("'", String.raw`'\''`);
    // вывод уходит в файл — сторож смотрит в него: рост — жизнь, хвост — лимит
    const outputFile = outputFileOf(command);
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
