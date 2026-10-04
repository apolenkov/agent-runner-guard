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
  // `cd $VAR`, `cd ~` и подобное без оболочки не разрешить — лучше не следить, чем следить не туда
  if (directory !== undefined && /^[$~]/.test(directory)) return undefined;
  if (directory !== undefined && path.isAbsolute(directory)) {
    return path.join(directory, target);
  }
  if (cwd === undefined || !path.isAbsolute(cwd)) return undefined;
  return path.join(cwd, directory ?? "", target);
}

// `pi -p` в позиции команды: после начала строки или `;`, `&`, `|`, `(`,
// через приставки (`env X=1`, `exec`, `timeout 600`, …) и с путём к файлу.
const PI_COMMAND =
  /(?<=(?:^|[;&|(\n])\s*)((?:(?:env|exec|nohup|nice|timeout|\w+=\S*|-\S+|\d+[smhd]?)\s+)*)(\S*\/)?pi(\s+)-p(?!\w)/g;

/**
 * Добавляет `-e <расширение>` к первому `pi -p` в позиции команды (начало
 * строки или после `;`, `&`, `|`, `(`, в том числе за приставками и с
 * путём) и вне кавычек: текст промпта и
 * `echo 'pi -p'` не трогаются. Подходящего нет — строка как есть.
 */
function withPiExtension(command: string, extension: string): string {
  for (const match of command.matchAll(PI_COMMAND)) {
    const [whole, prefix = "", directory = "", space = " "] = match;
    // кавычки проверяются у самого токена pi: приставка `X="… pi -p` — текст
    if (isQuotedAt(command, match.index + prefix.length + directory.length))
      continue;
    const quoted = extension.replaceAll("'", String.raw`'\''`);
    return `${command.slice(0, match.index)}${prefix}${directory}pi -e '${quoted}'${space}-p${command.slice(match.index + whole.length)}`;
  }
  return command;
}

/**
 * Стоит ли позиция внутри кавычек оболочки (с учётом `\` вне одинарных).
 */
function isQuotedAt(line: string, position: number): boolean {
  let quote: string | undefined;
  for (let index = 0; index < position; index += 1) {
    const char = line[index];
    if (char === "\\" && quote !== "'") index += 1;
    else if (quote === undefined && (char === "'" || char === '"'))
      quote = char;
    else if (char === quote) quote = undefined;
  }
  return quote !== undefined;
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
    // Pi: расширение сообщает сторожу об ошибке/лимите (alert-файл)
    const extension = path.join(
      path.dirname(watchdogPath),
      "harness",
      "pi-alert.ts",
    );
    const runner = existsSync(extension)
      ? withPiExtension(command, extension)
      : command;
    const quoted = runner.replaceAll("'", String.raw`'\''`);
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
