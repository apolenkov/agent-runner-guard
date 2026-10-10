/** Bounded static metadata from the maintained Bash AST, never shell evaluation. */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Language, type Node, Parser } from "web-tree-sitter";

import type { Executor } from "./devin.ts";
import {
  commandIndex,
  hasUnknownCwd,
  literalCdTarget,
  literalWord,
  resolvedPath,
  runnerOf,
  shellScriptIndex,
  shellTokens,
  stdoutFile,
} from "./runner-arguments.ts";

interface Stdout {
  file: string | undefined;
  redirects: Node[];
}
interface Word {
  value: string | undefined;
  end: number;
}
interface ShellCommand {
  executor: Executor | undefined;
  argv: (string | undefined)[];
  cwd: string | undefined;
  nameEnd: number | undefined;
  outputFile: string | undefined;
}
type RunnerCommand = ShellCommand & { executor: Executor };
interface Analysis {
  runners: RunnerCommand[];
  normalized: string;
  outputFile: string | undefined;
}

async function loadLanguage(): Promise<Language | undefined> {
  try {
    await Parser.init();
    return await Language.load(
      fileURLToPath(
        import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
      ),
    );
  } catch {
    return undefined;
  } // Hook failure stays fail-open; direct argv still works.
}
const language = await loadLanguage();
function commandWords(node: Node): Word[] {
  const name = node.childForFieldName("name");
  if (name === null) return [];
  return [name, ...node.childrenForFieldName("argument")].map((word) => ({
    value: literalWord(word),
    end: word.endIndex,
  }));
}

function pendingStdout(node: Node, stdout: Stdout): Stdout {
  return {
    file: stdout.file,
    redirects: [...node.childrenForFieldName("redirect"), ...stdout.redirects],
  };
}

function inspectCommand(
  node: Node,
  cwd: string | undefined,
  stdout: Stdout,
  runners: ShellCommand[],
): string | undefined {
  const words = commandWords(node);
  const start = commandIndex(words.map((word) => word.value));
  const argv = words
    .slice(start < 0 ? words.length : start)
    .map((word) => word.value);
  const executor = runnerOf(argv);
  const redirects = pendingStdout(node, stdout).redirects;
  runners.push({
    executor,
    argv,
    cwd,
    nameEnd: words[start]?.end,
    outputFile: stdoutFile(redirects, cwd, stdout.file),
  });
  if (argv[0] !== "cd") return hasUnknownCwd(argv) ? undefined : cwd;
  if (
    start !== 0 ||
    node.namedChildren.some((child) => child.type === "variable_assignment")
  )
    return undefined;
  return resolvedPath(literalCdTarget(argv), cwd);
}

function walkList(
  node: Node,
  cwd: string | undefined,
  stdout: Stdout,
  runners: ShellCommand[],
): string | undefined {
  const [left, right] = node.namedChildren;
  if (left === undefined || right === undefined) return undefined;
  const afterLeft = walk(
    left,
    cwd,
    { file: stdout.file, redirects: [] },
    runners,
  );
  const isAnd = node.children.some((child) => child.type === "&&");
  const afterRight = walk(
    right,
    isAnd ? afterLeft : undefined,
    stdout,
    runners,
  );
  return isAnd ? afterRight : undefined;
}

function walkSequence(
  node: Node,
  cwd: string | undefined,
  stdout: Stdout,
  runners: ShellCommand[],
): string | undefined {
  let current = cwd;
  for (const child of node.namedChildren) {
    if (child.type === "comment") continue;
    const after = walk(child, current, stdout, runners);
    // A semicolon/newline does not prove the previous cd succeeded.
    if (after !== current) current = undefined;
  }
  return current;
}

function walk(
  node: Node,
  cwd: string | undefined,
  stdout: Stdout,
  runners: ShellCommand[],
): string | undefined {
  if (node.type === "command")
    return inspectCommand(node, cwd, stdout, runners);
  if (node.type === "program") return walkSequence(node, cwd, stdout, runners);
  if (node.type === "subshell") {
    const file = stdoutFile(stdout.redirects, cwd, stdout.file);
    walkSequence(node, cwd, { file, redirects: [] }, runners);
    return cwd;
  }
  if (node.type === "list") return walkList(node, cwd, stdout, runners);
  if (node.type === "redirected_statement") {
    const body = node.childForFieldName("body");
    return body === null
      ? undefined
      : walk(body, cwd, pendingStdout(node, stdout), runners);
  }
  if (node.type === "pipeline") {
    const children = node.namedChildren;
    for (const child of children)
      walk(
        child,
        cwd,
        child === children.at(-1) ? stdout : { file: undefined, redirects: [] },
        runners,
      );
    return cwd;
  }
  return node.type === "comment" ? cwd : undefined;
}

/** Metadata from supported syntax positions; parse errors yield no runner. */
export function analyzeShell(script: string, cwd?: string): Analysis {
  const fallback = { runners: [], normalized: script, outputFile: undefined };
  if (language === undefined) return fallback;
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(script);
  try {
    if (tree === null || tree.rootNode.hasError) return fallback;
    const runners: ShellCommand[] = [];
    walk(
      tree.rootNode,
      cwd !== undefined && path.isAbsolute(cwd) ? cwd : undefined,
      { file: undefined, redirects: [] },
      runners,
    );
    return {
      runners: runners.filter(
        (command): command is RunnerCommand => command.executor !== undefined,
      ),
      normalized: shellTokens(tree.rootNode).join(" ").trim(),
      outputFile: runners.findLast(
        (command) => command.outputFile !== undefined,
      )?.outputFile,
    };
  } finally {
    tree?.delete();
    parser.delete();
  }
}

/** Direct argv uses exactly its supplied values; only the shell script is parsed. */
export function analyzeCommand(
  command: string[],
  cwd: string,
): {
  runners: RunnerCommand[];
  normalized: string[];
  outputFile: string | undefined;
} {
  const scriptIndex = shellScriptIndex(command);
  if (scriptIndex !== undefined) {
    const analysis = analyzeShell(command[scriptIndex] ?? "", cwd);
    return {
      runners: analysis.runners,
      outputFile: analysis.outputFile,
      normalized: command.map((argument, index) =>
        index === scriptIndex ? analysis.normalized : argument,
      ),
    };
  }
  const start = commandIndex(command);
  const argv = start < 0 ? [] : command.slice(start);
  const executor = runnerOf(argv);
  return {
    runners:
      executor === undefined
        ? []
        : [{ executor, argv, cwd, nameEnd: undefined, outputFile: undefined }],
    normalized: command,
    outputFile: undefined,
  };
}

/** Known prompt path, never reconstructed from joined argv. */
export function promptPath(
  runner: RunnerCommand | undefined,
): string | undefined {
  if (runner === undefined) return undefined;
  for (let index = 1; index < runner.argv.length; index += 1) {
    const argument = runner.argv[index];
    if (argument === "--prompt-file")
      return resolvedPath(runner.argv[index + 1], runner.cwd);
    if (argument?.startsWith("--prompt-file="))
      return resolvedPath(argument.slice("--prompt-file=".length), runner.cwd);
  }
  return undefined;
}
