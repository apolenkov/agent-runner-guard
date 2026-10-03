/**
 * Хук Claude Code PreToolUse (Bash): команды `devin -p`, `pi -p` и
 * `codex exec` оборачиваются в сторож запусков (`src/watchdog.ts`) через
 * `updatedInput`.
 * JSON со стандартного ввода → JSON со стандартного вывода. Хук никогда не
 * блокирует: любой сбой, чужая команда или отсутствие сторожа → пустой
 * вывод и код 0 (команда идёт как есть).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = /(?<![\w-])(?:(?:devin|pi)\s+-p|codex\s+exec)(?!\w)/;

/**
 * Куда команда отправляет вывод исполнителя: первая перенаправленная
 * в файл стандартная выдача (`> f`, `>> f`, `1> f`, в кавычках или без)
 * после `devin -p`/`pi -p`. Нет — undefined (вывод и так виден сторожу).
 */
export function outputFileOf(
  command: string,
  cwd?: string,
): string | undefined {
  const start = RUNNER.exec(command)?.index ?? 0;
  const redirect =
    /(?:^|[\s;])1?>>?\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|<>]+))/.exec(
      command.slice(start),
    );
  const target = redirect?.[1] ?? redirect?.[2] ?? redirect?.[3];
  if (target === undefined || target.startsWith("&")) return undefined;
  if (target === "/dev/null") return undefined;
  if (path.isAbsolute(target)) return target;
  // сторож работает в каталоге инструмента, а `cd` внутри команды — в дочерней оболочке:
  // относительный путь разрешаем от последнего `cd` перед исполнителем (или от cwd хука)
  const changes = command
    .slice(0, start)
    .matchAll(/(?:^|[\s;&|(])cd\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|<>]+))/g)
    .toArray();
  const last = changes.at(-1);
  const directory = last?.[1] ?? last?.[2] ?? last?.[3];
  if (directory !== undefined && path.isAbsolute(directory)) {
    return path.join(directory, target);
  }
  if (cwd === undefined || !path.isAbsolute(cwd)) return undefined;
  return path.join(cwd, directory ?? "", target);
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
    const outputFile = outputFileOf(
      command,
      typeof cwd === "string" ? cwd : undefined,
    );
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
