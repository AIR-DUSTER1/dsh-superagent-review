#!/usr/bin/env node

import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"]);
  execFileSync("git", ["config", "commit.template", ".gitmessage"]);
  console.log("✓ Git hooks 已安装：.githooks");
  console.log("✓ 已设置提交模板：.gitmessage");
} catch {
  console.warn("跳过 Git hooks 安装：当前目录不是 Git 工作区或 Git 不可用");
}
