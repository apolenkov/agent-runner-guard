import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  cpuTimeSum,
  executorOf,
  findAcpLog,
  isDevinAcp,
} from "../src/devin.ts";

void test("executorOf: devin -p, pi (не pipe/pip/piper), codex exec", () => {
  assert.equal(executorOf("devin -p задача"), "devin");
  assert.equal(executorOf("devin acp --stdio"), undefined);
  assert.equal(executorOf("pi --session work"), "pi");
  assert.equal(executorOf("/usr/local/bin/pi run"), "pi");
  for (const command of ["pipe something", "pip install x", "piper --loud"]) {
    assert.equal(executorOf(command), undefined, command);
  }
  assert.equal(executorOf("codex exec 'задача'"), "codex");
  assert.equal(executorOf("codex exec review 'план'"), "codex");
  assert.equal(executorOf("/opt/homebrew/bin/codex exec 'x'"), "codex");
  assert.equal(executorOf("codex --version"), undefined);
  assert.equal(executorOf("mycodex exec x"), undefined);
});

void test("executorOf: глобальные опции codex перед exec", () => {
  for (const command of [
    "codex -c a=b exec 'задача'",
    "codex --config a=b exec 'x'",
    "codex -m gpt-5 exec 'x'",
    "codex --model gpt-5 exec 'x'",
    "codex -p work exec 'x'",
    "codex --profile work exec 'x'",
    "codex --model gpt-5 -c a=b --profile work exec 'x'",
  ]) {
    assert.equal(executorOf(command), "codex", command);
  }
  // прочая опция пропускается без значения: «read-only» принимается за
  // субкоманду — граница эвристики
  assert.equal(executorOf("codex --sandbox read-only exec 'x'"), undefined);
  // -c съел «exec» как значение — не запуск
  assert.equal(executorOf("codex -c exec"), undefined);
});

void test("findAcpLog: журнал по pid acp; нет каталога или файла — undefined", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "acp-log-"));
  try {
    await writeFile(path.join(directory, "devin_2026_777.log"), "x");
    const found = await findAcpLog(directory, 777);
    assert.equal(found?.file, path.join(directory, "devin_2026_777.log"));
    assert.equal(await findAcpLog(directory, 778), undefined);
    assert.equal(await findAcpLog(path.join(directory, "нет"), 777), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("isDevinAcp; cpuTimeSum: пустой список и несуществующий pid — 0", async () => {
  assert.equal(isDevinAcp("/usr/bin/devin acp"), true);
  assert.equal(isDevinAcp("devin -p x"), false);
  assert.equal(await cpuTimeSum([2_147_483_647]), 0);
  assert.equal(await cpuTimeSum([]), 0);
});
