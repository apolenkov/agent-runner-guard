import assert from "node:assert/strict";
import { test } from "node:test";
import { mask } from "../src/mask.ts";

void test("маскирует ключ sk-…", () => {
  assert.equal(mask("ключ sk-abcdef0123456789 в логе"), "ключ sk-*** в логе");
});

void test("маскирует ключ sk-ant-…, сохраняя префикс", () => {
  assert.equal(mask("токен sk-ant-api03-aabbccdd1122"), "токен sk-ant-***");
});

void test("не трогает слово «sk» и похожие слова", () => {
  const text = "обычный текст про sk и task-done без секретов";
  assert.equal(mask(text), text);
});

void test("маскирует Bearer-токен", () => {
  assert.equal(
    mask("Authorization: Bearer abc.def.ghi"),
    "Authorization: Bearer ***",
  );
});

void test("маскирует значение для имён с TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL", () => {
  assert.equal(mask("API_TOKEN=sekret123"), "API_TOKEN=***");
  assert.equal(mask("DB_PASSWORD=hunter2"), "DB_PASSWORD=***");
  assert.equal(mask("AWS_SECRET=zz top"), "AWS_SECRET=*** top");
  assert.equal(mask("SSH_PASS=x"), "SSH_PASS=***");
  assert.equal(mask("MY_CREDENTIAL=y"), "MY_CREDENTIAL=***");
  assert.equal(mask("THE_KEY=zzz"), "THE_KEY=***");
  assert.equal(mask('API_TOKEN="sek ret"'), "API_TOKEN=***");
});

void test("не трогает key=value с безобидным именем", () => {
  assert.equal(mask("color=red mode=fast"), "color=red mode=fast");
  assert.equal(mask("key=value"), "key=value");
});

void test("маскирует пути к credentials.toml", () => {
  assert.equal(
    mask("читаю ~/.config/x/credentials.toml"),
    "читаю <credentials>",
  );
  assert.equal(mask("/a/b/credentials.toml открыт"), "<credentials> открыт");
});
