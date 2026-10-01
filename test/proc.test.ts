import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  checkNames,
  descendants,
  descendantsOf,
  listProcesses,
  cwdOf,
  parsePsList,
} from "../src/proc.ts";

void test("parsePsList разбирает ps -axo pid=,ppid=,etime=,command=", () => {
  const output = [
    "  123     1 02:30:15 /usr/bin/foo --arg one",
    "   45   123    2-03:04:05 bar baz",
    "    7     1       00:05 sleep 5",
  ].join("\n");
  const list = parsePsList(output);
  assert.deepEqual(list, [
    {
      pid: 123,
      ppid: 1,
      etimeSeconds: 2 * 3600 + 30 * 60 + 15,
      command: "/usr/bin/foo --arg one",
    },
    {
      pid: 45,
      ppid: 123,
      etimeSeconds: 2 * 86_400 + 3 * 3600 + 4 * 60 + 5,
      command: "bar baz",
    },
    { pid: 7, ppid: 1, etimeSeconds: 5, command: "sleep 5" },
  ]);
});

void test("listProcesses: видим себя с настоящим ppid", async () => {
  const list = await listProcesses();
  const self = list.find((p) => p.pid === process.pid);
  assert.ok(self !== undefined);
  assert.equal(self.ppid, process.ppid);
});

void test("cwdOf: рабочий каталог текущего процесса", async () => {
  assert.equal(await cwdOf(process.pid), process.cwd());
});

void test("cwdOf: несуществующий pid → undefined", async () => {
  assert.equal(await cwdOf(2_147_483_647), undefined);
});

void test("descendantsOf: всё дерево потомков", () => {
  const list = parsePsList(
    [
      "   10     1 00:01 parent",
      "   11    10 00:01 child",
      "   12    11 00:01 grandchild",
      "   13    10 00:01 child2",
      "   99     1 00:01 other",
    ].join("\n"),
  );
  assert.deepEqual(
    descendantsOf(list, 10).map((p) => p.pid),
    [11, 13, 12],
  );
  assert.deepEqual(descendantsOf(list, 99), []);
});

void test("descendants: живой потомок виден", async () => {
  const child = spawn("sleep", ["5"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const all = await descendants(process.pid);
    assert.ok(all.some((p) => p.pid === child.pid));
  } finally {
    child.kill();
  }
});

void test("checkNames: узнаёт проверки по имени в команде", () => {
  assert.deepEqual(
    checkNames([
      "node ./node_modules/vitest/vitest.mjs run",
      "sh -c prettier --check .",
      "sleep 1",
    ]),
    ["vitest", "prettier"],
  );
  assert.deepEqual(checkNames(["ls -la"]), []);
});
