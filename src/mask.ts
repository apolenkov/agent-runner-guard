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
 * - пути к `credentials.toml` (весь путь — `<credentials>`).
 */
export function mask(text: string): string {
  return text
    .replaceAll(
      /\b[\w-]*(?:token|secret|key|password|pass|credential)[\w-]*=(?:"[^"]*"|'[^']*'|\S*)/gi,
      (m) => `${m.slice(0, m.indexOf("="))}=***`,
    )
    .replaceAll(/\bsk-(ant-)?[\w-]{4,}/g, (m, ant: string | undefined) =>
      ant === undefined ? "sk-***" : "sk-ant-***",
    )
    .replaceAll(
      /\b(Bearer|Basic)[ \t]+\S+/gi,
      (m, scheme: string) => `${scheme} ***`,
    )
    .replaceAll(/\S*credentials\.toml\b/g, "<credentials>");
}
