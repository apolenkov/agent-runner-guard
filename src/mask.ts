/**
 * Единая функция маскирования секретов в показываемом тексте.
 *
 * Закрывает:
 * - ключи вида `sk-…` и `sk-ant-…` (длинный хвост после префикса);
 * - токен после слова `Bearer`;
 * - значения в `ИМЯ=значение`, если имя содержит
 *   TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL (имя оставляем, значение — `***`);
 * - пути к `credentials.toml` (весь путь — `<credentials>`).
 */
export function mask(text: string): string {
  return text
    .replaceAll(
      /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)/g,
      (m) => `${m.slice(0, m.indexOf("="))}=***`,
    )
    .replaceAll(/\bsk-(ant-)?[\w-]{4,}/g, (m, ant: string | undefined) =>
      ant === undefined ? "sk-***" : "sk-ant-***",
    )
    .replaceAll(/\bBearer[ \t]+\S+/g, "Bearer ***")
    .replaceAll(/\S*credentials\.toml\b/g, "<credentials>");
}
