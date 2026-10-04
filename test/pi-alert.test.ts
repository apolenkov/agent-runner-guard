import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import piAlert from "../src/harness/pi-alert.ts";

type Handler = (event: unknown) => void;

/**
 * Подставной объект Pi: копит подписки, `emit` вызывает их по имени.
 */
function fakePi(): {
  on: (name: string, handler: Handler) => void;
  emit: (name: string, event: unknown) => void;
  names: () => string[];
} {
  const handlers = new Map<string, Handler[]>();
  return {
    on: (name, handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    emit: (name, event) => {
      const list = handlers.get(name) ?? [];
      for (const handler of list) handler(event);
    },
    names: () => handlers.keys().toArray(),
  };
}

const failed = (errorMessage: string): unknown => ({
  message: { role: "assistant", stopReason: "error", errorMessage },
});

void test("pi-alert: ошибка после ретраев → error с текстом, лимит → rate_limit, completed → ничего", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-alert-"));
  try {
    const cases: [string, string, string | undefined][] = [
      ["OpenAI API error (401): bad key", "completed", undefined],
      ["OpenAI API error (401): bad key", "error", "error"],
      ["429 Too Many Requests: rate limit", "error", "rate_limit"],
    ];
    for (const [index, [message, outcome, type]] of cases.entries()) {
      const file = path.join(directory, `${String(index)}.jsonl`);
      const pi = fakePi();
      piAlert(pi, file);
      pi.emit("message_end", { message: { role: "user" } });
      pi.emit("message_end", failed(message));
      pi.emit("agent_before_settle", { outcome });
      let text = "";
      try {
        text = await readFile(file, "utf8");
      } catch {
        // нет файла — событий не было
      }
      if (type === undefined) {
        assert.equal(text, "");
      } else {
        assert.deepEqual(JSON.parse(text), { type, source: "pi", message });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("pi-alert: без HARNESS_ALERT_FILE подписок нет", () => {
  // тесты сами могут идти под сторожем, который задаёт переменную
  const saved = process.env.HARNESS_ALERT_FILE;
  delete process.env.HARNESS_ALERT_FILE;
  try {
    const pi = fakePi();
    piAlert(pi);
    assert.deepEqual(pi.names(), []);
  } finally {
    if (saved !== undefined) process.env.HARNESS_ALERT_FILE = saved;
  }
});

void test("pi-alert: сбой записи не роняет Pi", () => {
  const pi = fakePi();
  piAlert(pi, path.join(tmpdir(), "нет-такого-каталога", "a.jsonl"));
  pi.emit("message_end", failed("boom"));
  assert.doesNotThrow(() => {
    pi.emit("agent_before_settle", { outcome: "error" });
  });
});

void test("pi-alert: признак лимита после 2000 символов и длинный текст сохраняются целиком", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-alert-long-"));
  try {
    const file = path.join(directory, "a.jsonl");
    const message = `${"x".repeat(3000)} 429 rate limit`;
    const pi = fakePi();
    piAlert(pi, file);
    pi.emit("message_end", failed(message));
    pi.emit("agent_before_settle", { outcome: "error" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      type: "rate_limit",
      source: "pi",
      message,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
