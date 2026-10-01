import { open } from "node:fs/promises";

/**
 * Чтение только хвоста файла.
 */

/**
 * Читает последние `maxBytes` файла через fs.open + позиционное чтение.
 * Если хвост отрезан посередине строки — отбрасывает неполную первую
 * строку; если перевода строки в хвосте нет вовсе (сплошной поток),
 * отдаёт кусок как есть. Файла нет → undefined. Символические ссылки
 * работают (open их разыменовывает).
 */
export async function readTail(
  path: string,
  maxBytes = 65_536,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const boundary = text.indexOf("\n");
      if (boundary !== -1) text = text.slice(boundary + 1);
    }
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * Читает первые `maxBytes` файла; файла нет → undefined. Последняя строка
 * может быть оборвана — разбирающий код пропускает битые строки.
 */
export async function readHead(
  path: string,
  maxBytes = 65_536,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
