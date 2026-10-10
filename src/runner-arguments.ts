/** Static argv policy shared by shell metadata and direct watchdog invocations. */
import path from "node:path";

import { parse as parseWord } from "shell-quote";
import type { Node } from "web-tree-sitter";

import type { Executor } from "./devin.ts";

type Arguments = readonly (string | undefined)[];
// Verified against the saved 2026-10-09 Codex CLI help. Variadic --image is unknown.
const CODEX_VALUES = new Set([
  "-c",
  "--config",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "-a",
  "--ask-for-approval",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "--local-provider",
  "--add-dir",
]);
const CODEX_SWITCHES = new Set([
  "--strict-config",
  "--oss",
  "--approve-for-me",
  "--search",
  "--no-alt-screen",
  "--no-daemon",
  "--worktree",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
]);
const WRAPPER_SWITCHES: Record<string, Set<string>> = {
  env: new Set(["-i", "--ignore-environment"]),
  exec: new Set(["-c", "-l"]),
  nohup: new Set(),
  nice: new Set(),
  timeout: new Set(["--preserve-status", "--foreground", "--verbose"]),
};
const WRAPPER_VALUE_NAMES: Record<string, Set<string>> = {
  env: new Set(["-u", "--unset"]),
  exec: new Set(["-a"]),
  nohup: new Set(),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
};

function wrapperEnd(argv: Arguments, start: number, binary: string): number {
  let index = start + 1;
  while (argv[index]?.startsWith("-")) {
    const option = argv[index] ?? "";
    if (option === "--") {
      if (binary !== "env") return index + 1;
      index += 1;
      break;
    }
    const [name = ""] = option.split("=", 1);
    if (WRAPPER_VALUE_NAMES[binary]?.has(name)) {
      if (!option.includes("=")) {
        if (argv[index + 1] === undefined) return -1;
        index += 1;
      }
    } else if (!WRAPPER_SWITCHES[binary]?.has(option)) return -1;
    index += 1;
  }
  if (binary === "timeout") {
    if (!/^\d+(?:\.\d+)?[smhd]?$/.test(argv[index] ?? "")) return -1;
    index += 1;
  } else if (binary === "env")
    while (/^[A-Za-z_]\w*=/.test(argv[index] ?? "")) index += 1;
  return index;
}

/** Index of the real command behind the finite supported wrapper grammar. */
export function commandIndex(argv: Arguments): number {
  let index = 0;
  while (index < argv.length) {
    const value = argv[index];
    if (value === undefined) return -1;
    const binary = path.basename(value);
    if (!Object.hasOwn(WRAPPER_SWITCHES, binary)) return index;
    index = wrapperEnd(argv, index, binary);
    if (index < 0) return -1;
  }
  return -1;
}

function isCodexExec(argv: Arguments): boolean {
  let index = 1;
  while (index < argv.length) {
    const option = argv[index];
    if (option === "exec") return true;
    if (option === undefined || !option.startsWith("-")) return false;
    const [name = ""] = option.split("=", 1);
    const isAttached =
      /^-[cmpCsa]/.test(option) &&
      option.length > 2 &&
      !option.startsWith("--");
    if (isAttached || CODEX_VALUES.has(name)) {
      if (!isAttached && !option.includes("=")) {
        if (argv[index + 1] === undefined || argv[index + 1]?.startsWith("-"))
          return false;
        index += 1;
      }
    } else if (!CODEX_SWITCHES.has(option)) return false;
    index += 1;
  }
  return false;
}

/** Runner kind from intact argv; quoted argument text is never command source. */
export function runnerOf(argv: Arguments): Executor | undefined {
  const binary = path.basename(argv[0] ?? "");
  if (binary === "devin" && argv.slice(1).includes("-p")) return "devin";
  if (binary === "pi") return "pi";
  return binary === "codex" && isCodexExec(argv) ? "codex" : undefined;
}

/** Script index in the finite sh/bash/zsh short-option grammar. */
export function shellScriptIndex(argv: readonly string[]): number | undefined {
  const start = commandIndex(argv);
  if (!/^(?:ba|z)?sh$/.test(path.basename(argv[start] ?? ""))) return undefined;
  for (let index = start + 1; index < argv.length; index += 1) {
    const option = argv[index] ?? "";
    if (!/^-[aefhklmnptuvxBCEHPTc]+$/.test(option)) return undefined;
    if (option.includes("c"))
      return argv[index + 1] === undefined ? undefined : index + 1;
  }
  return undefined;
}

const LITERAL_TYPES = new Set([
  "command_name",
  "word",
  "number",
  "string",
  "string_content",
  "raw_string",
  "concatenation",
]);

function isLiteral(node: Node): boolean {
  if (!LITERAL_TYPES.has(node.type)) return false;
  if (node.type === "word" && /(^|[^\\])[~*?[\]{}]/.test(node.text))
    return false;
  return node.namedChildren.every((child) => isLiteral(child));
}

export function literalWord(node: Node): string | undefined {
  if (!isLiteral(node)) return undefined;
  try {
    const words = parseWord(node.text, () => ({ dynamic: true }));
    return words.length === 1 && typeof words[0] === "string"
      ? words[0]
      : undefined;
  } catch {
    return undefined;
  }
}

export function shellTokens(node: Node): string[] {
  if (node.type === "file_redirect") {
    const operator = node.children.find((child) => !child.isNamed)?.text;
    return [">", ">>", "&>", "&>>", ">&", ">&-"].includes(operator ?? "")
      ? []
      : [node.text];
  }
  if (LITERAL_TYPES.has(node.type) || node.type === "variable_assignment")
    return [node.text];
  if (
    ![
      "program",
      "command",
      "list",
      "subshell",
      "pipeline",
      "redirected_statement",
    ].includes(node.type)
  )
    return [node.text];
  return node.children.flatMap((child) =>
    child.isNamed ? shellTokens(child) : child.text,
  );
}

/** These constructs can mutate cwd or dispatch an unknown shell builtin. */
export function hasUnknownCwd(argv: Arguments): boolean {
  return (
    argv[0] === undefined ||
    [".", "source", "eval", "pushd", "popd", "builtin", "command"].includes(
      argv[0],
    )
  );
}

/** The finite literal cd operand grammar, without HOME/OLDPWD/CDPATH expansion. */
export function literalCdTarget(argv: Arguments): string | undefined {
  const operands = argv.slice(1);
  const hasSeparator = operands[0] === "--";
  if (hasSeparator) operands.shift();
  if (operands.length !== 1) return undefined;
  const target = operands[0];
  if (target === undefined || target === "-") return undefined;
  if (!hasSeparator && target.startsWith("-")) return undefined;
  if (
    process.env.CDPATH &&
    !path.isAbsolute(target) &&
    !/^\.\.?(?:$|\/)/.test(target)
  )
    return undefined;
  return target;
}

/** Literal path resolution shared by stdout, cd and prompt metadata. */
export function resolvedPath(
  file: string | undefined,
  cwd: string | undefined,
): string | undefined {
  if (file === undefined || ["", "/dev/null"].includes(file)) return undefined;
  if (path.isAbsolute(file)) return file;
  return cwd === undefined ? undefined : path.resolve(cwd, file);
}

export function stdoutFile(
  redirects: Node[],
  cwd: string | undefined,
  inherited: string | undefined,
): string | undefined {
  let target = inherited;
  for (const redirect of redirects) {
    if (redirect.type !== "file_redirect") continue;
    const descriptor = redirect.childForFieldName("descriptor")?.text;
    if (descriptor !== undefined && descriptor !== "1") continue;
    const operator = redirect.children.find((child) => !child.isNamed)?.text;
    if ([">", ">>", "&>", "&>>"].includes(operator ?? "")) {
      const destinations = redirect.childrenForFieldName("destination");
      target =
        destinations.length === 1 && destinations[0] !== undefined
          ? literalWord(destinations[0])
          : undefined;
    } else if (operator === ">&" || operator === ">&-") target = undefined;
  }
  return resolvedPath(target, cwd);
}
