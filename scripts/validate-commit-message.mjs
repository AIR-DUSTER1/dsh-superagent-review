#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TYPES = new Set(["feat", "fix", "refactor", "style", "i18n", "chore"]);
const COMMIT_RE = /^(?<type>[a-z0-9]+): (?<subject>.+)$/u;
const HAN_RE = /\p{Script=Han}/u;
const END_PUNCTUATION_RE = /[。.!！?？;；,，:：]$/u;
const NUMBERED_LIST_RE = /^\d+[.、)）]\s+/u;
const VAGUE_SUBJECT_RE = /^(?:wip|update|changes|fix bug)$/iu;

function usage() {
  console.error(
    "Usage: node scripts/validate-commit-message.mjs <commit-message-file> | --last | --range <git-range>",
  );
}

function cleanMessage(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

export function validateMessage(raw, source) {
  const message = cleanMessage(raw);
  const lines = message.split(/\r?\n/);
  const header = lines[0]?.trim() ?? "";
  const errors = [];

  if (!header) {
    errors.push("提交信息不能为空");
    return { errors, header, source };
  }

  const match = COMMIT_RE.exec(header);
  if (!match?.groups) {
    errors.push(
      "提交信息必须符合单行格式 `<type>: <中文主题>，<具体变更>`，不允许 scope、! 或正文",
    );
  } else {
    const { type, subject } = match.groups;
    if (!TYPES.has(type)) {
      errors.push(`不允许的 type \`${type}\`；允许：${[...TYPES].join(", ")}`);
    }
    if (subject.trim() !== subject) {
      errors.push("主题不能带有首尾空白");
    }
    if (!HAN_RE.test(subject)) {
      errors.push("主题必须使用中文描述");
    }
    if (END_PUNCTUATION_RE.test(subject)) {
      errors.push("主题末尾不能带句号或其它标点");
    }
    if (NUMBERED_LIST_RE.test(subject)) {
      errors.push("主题不能使用序号列表");
    }
    if (VAGUE_SUBJECT_RE.test(subject)) {
      errors.push("主题不能使用 WIP、update、changes、fix bug 等空泛描述");
    }
  }

  if (lines.length !== 1) {
    errors.push("整个提交信息只能有一行，不能包含空行、正文或 footer");
  }

  return { errors, header, source };
}

function report(results) {
  let failed = false;
  for (const result of results) {
    if (result.errors.length === 0) continue;
    failed = true;
    console.error(`\n✗ ${result.source}`);
    console.error(`  ${result.header || "(空)"}`);
    for (const error of result.errors) console.error(`  - ${error}`);
  }
  if (failed) {
    console.error("\n提交信息未通过校验，请按 AGENTS.md 的 Git 规范修改后重试。");
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 已校验 ${results.length} 个提交信息`);
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    ...options,
  });
}

function readFileOrThrow(path) {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch {
    throw new Error(`无法读取提交信息文件：${path}`);
  }
}

function main() {
  const [mode, value] = process.argv.slice(2);

  if (!mode || mode === "--help" || mode === "-h") {
    usage();
    process.exitCode = mode ? 0 : 1;
    return;
  }

  if (mode === "--last") {
    const message = git(["log", "-1", "--format=%B"]).trim();
    report([validateMessage(message, "HEAD")]);
    return;
  }

  if (mode === "--range") {
    if (!value) throw new Error("--range 需要一个 Git 提交范围，例如 origin/main..HEAD");
    const hashes = git(["rev-list", "--reverse", value]).trim().split(/\s+/).filter(Boolean);
    if (hashes.length === 0) {
      console.log("✓ 指定范围没有需要校验的提交");
      return;
    }
    report(
      hashes.map((hash) => {
        const message = git(["show", "-s", "--format=%B", hash]).trim();
        return validateMessage(message, `${hash.slice(0, 12)} ${message.split(/\r?\n/, 1)[0]}`);
      }),
    );
    return;
  }

  report([validateMessage(readFileOrThrow(mode), mode)]);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(`提交信息校验失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
