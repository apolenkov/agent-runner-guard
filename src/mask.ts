/**
 * Единая функция маскирования секретов в показываемом тексте.
 *
 * Закрывает:
 * - ключи вида `sk-…` и `sk-ant-…` (длинный хвост после префикса);
 * - токен после слов `Bearer` и `Basic` (регистр любой, слово сохраняется);
 * - значения в `ИМЯ=значение`, если имя в любом регистре содержит
 *   token|secret|key|password|pass|credential (имя оставляем, значение —
 *   `***`); имя, лишь содержащее ключевое слово внутри (`keyboard`,
 *   `monkeyPatch`), тоже маскируется — сознательно консервативно;
 * - пробелы вокруг `=` (`api_key = "…"`), пара `имя: "значение"` в кавычках
 *   (JSON/YAML), `Authorization: <схема> <токен>`;
 * - токены с префиксами `ghp_`/`gho_`/…, `xoxb-`…, `AKIA` + 16 знаков;
 * - пути к `credentials.toml` (весь путь — `<credentials>`).
 */
export function mask(text: string): string {
  return text
    .replaceAll(
      /(\b[\w-]*(?:token|secret|key|password|pass|credential)[\w-]*[ \t]*=[ \t]*)(?:"[^"]*"|'[^']*'|\S*)/gi,
      (_m, head: string) => `${head}***`,
    )
    .replaceAll(
      /(\b[\w-]*(?:token|secret|key|password|pass|credential)[\w-]*["']?[ \t]*:[ \t]*)(?:"[^"]*"|'[^']*')/gi,
      (_m, head: string) => `${head}***`,
    )
    .replaceAll(
      /\b(Authorization:[ \t]*\w+)[ \t]+\S+/gi,
      (_m, head: string) => `${head} ***`,
    )
    .replaceAll(/\bgh[opusr]_\w{16,}/g, "gh***")
    .replaceAll(/\bxox[abeprs]-[\w-]{8,}/g, "xox***")
    .replaceAll(/\bAKIA[A-Z0-9]{16}\b/g, "AKIA***")
    .replaceAll(/\bsk-(ant-)?[\w-]{4,}/g, (m, ant: string | undefined) =>
      ant === undefined ? "sk-***" : "sk-ant-***",
    )
    .replaceAll(
      /\b(Bearer|Basic)[ \t]+\S+/gi,
      (m, scheme: string) => `${scheme} ***`,
    )
    .replaceAll(/\S*credentials\.toml\b/g, "<credentials>");
}
