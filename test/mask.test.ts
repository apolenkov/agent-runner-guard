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

void test("маскирует имена секретов в любом регистре", () => {
  assert.equal(mask("api_key=sekret123"), "api_key=***");
  assert.equal(mask("Token=abc.def"), "Token=***");
  assert.equal(mask("mySecret=zzz"), "mySecret=***");
  assert.equal(mask("dbPassword=hunter2"), "dbPassword=***");
  assert.equal(mask("SSH_PASS=x"), "SSH_PASS=***");
  assert.equal(mask("key=value"), "key=***");
  assert.equal(mask("x-api-key=top"), "x-api-key=***");
});

void test("консервативно маскирует «key» внутри слова", () => {
  // Решение зафиксировано: имя, лишь СОДЕРЖАЩЕЕ token|key|… внутри слова,
  // тоже маскируется — лишнее маскирование безопаснее утечки.
  assert.equal(mask("keyboard=us"), "keyboard=***");
  assert.equal(mask("monkeyPatch=1"), "monkeyPatch=***");
});

void test("не трогает имена без «=» и безобидные key=value", () => {
  assert.equal(
    mask("call monkeyPatch(el) и color=red mode=fast"),
    "call monkeyPatch(el) и color=red mode=fast",
  );
});

void test("маскирует Authorization: Basic …", () => {
  assert.equal(
    mask("Authorization: Basic dXNlcjpwYXNz"),
    "Authorization: Basic ***",
  );
  assert.equal(mask("basic abc123"), "basic ***");
});

void test("маскирует пути к credentials.toml", () => {
  assert.equal(
    mask("читаю ~/.config/x/credentials.toml"),
    "читаю <credentials>",
  );
  assert.equal(mask("/a/b/credentials.toml открыт"), "<credentials> открыт");
});

void test("маскирует значения с пробелами вокруг «=» (TOML)", () => {
  assert.equal(mask('api_key = "abc def"'), "api_key = ***");
  assert.equal(mask("token = 'zzz'"), "token = ***");
  assert.equal(
    mask("DB_PASSWORD  =  hunter2 дальше"),
    "DB_PASSWORD  =  *** дальше",
  );
});

void test("маскирует пары «имя: значение» в кавычках", () => {
  assert.equal(mask('{"api_key": "abc123"}'), '{"api_key": ***}');
  assert.equal(mask("secret: 'abc'"), "secret: ***");
});

void test("маскирует Authorization: token …", () => {
  assert.equal(mask("Authorization: token abc123"), "Authorization: token ***");
  assert.equal(mask("authorization: Bearer abc"), "authorization: Bearer ***");
});

// префикс отдельно: целиком синтетический ключ ловится сканером секретов
const awsPrefix = String.fromCodePoint(65, 75, 73, 65);

void test("маскирует токены с известными префиксами", () => {
  assert.equal(mask(`a ghp_${"A1b2".repeat(9)} b`), "a gh*** b");
  assert.equal(mask(`gho_${"x".repeat(30)}`), "gh***");
  assert.equal(mask("xoxb-123456789012-abcdefABCDEF"), "xox***");
  assert.equal(
    mask(`id ${awsPrefix}ABCDEFGHIJKLMNOP конец`),
    "id AKIA*** конец",
  );
});

void test("обычный текст со знаками «=» и «:» не трогает", () => {
  const text = "a = b; цвет: красный; token limit reached; AKIA short ghp_x";
  assert.equal(mask(text), text);
});
