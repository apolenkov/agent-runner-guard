import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readTail } from "../src/tail.ts";

async function withTemporaryDirectory(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "tail-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test("файл меньше maxBytes читается целиком", async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, "out");
    await writeFile(file, "раз\nдва\nтри\n");
    assert.equal(await readTail(file), "раз\nдва\nтри\n");
  });
});

void test("файл больше maxBytes: хвост обрезан до границы строки", async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, "out");
    // 100 строк по 10 байт = 1000 байт
    const lines = Array.from(
      { length: 100 },
      (_, index) => `line-${String(index).padStart(4, "0")}`,
    );
    await writeFile(file, `${lines.join("\n")}\n`);
    const tail = await readTail(file, 150);
    assert.ok(tail !== undefined);
    // начало хвоста — целая строка, не её середина
    assert.match(tail.split("\n", 1)[0] ?? "", /^line-\d{4}$/);
    // конец файла дошёл полностью
    assert.ok(tail.endsWith("line-0099\n"));
    // и уложились в лимит
    assert.ok(Buffer.byteLength(tail) <= 150);
  });
});

void test("файл без перевода строки в хвосте отдаётся как есть", async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, "out");
    await writeFile(file, "x".repeat(200));
    assert.equal(await readTail(file, 50), "x".repeat(50));
  });
});

void test("символическая ссылка читается", async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, "out");
    const link = path.join(directory, "link");
    await writeFile(file, "содержимое\n");
    await symlink(file, link);
    assert.equal(await readTail(link), "содержимое\n");
  });
});

void test("нет файла — undefined", async () => {
  await withTemporaryDirectory(async (directory) => {
    assert.equal(await readTail(path.join(directory, "missing")), undefined);
  });
});
