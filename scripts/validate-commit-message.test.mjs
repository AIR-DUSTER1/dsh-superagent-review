import assert from "node:assert/strict";
import test from "node:test";

import { validateMessage } from "./validate-commit-message.mjs";

function getErrors(message) {
  return validateMessage(message, "test").errors;
}

test("接受允许类型的单行中文提交信息", () => {
  const messages = [
    "feat: 新增多仓库路由页面，支持仓库描述匹配和工作区隔离",
    "fix: 修复来源插件部署前读取上下文导致插件未安装问题，延迟解析命令和部署信息",
    "refactor: 重构运行时启动流程，拆分状态锁恢复和部署配置解析",
    "style: 调整工作区列表间距，统一状态标签和操作按钮样式",
    "i18n: 补充管理面板中文文案，统一错误提示和空状态说明",
    "chore: 更新提交信息校验工具，增加本地 hook 和自动测试",
  ];
  for (const message of messages) assert.deepEqual(getErrors(message), []);
});

test("拒绝旧式 scope、多行和不允许的 type", () => {
  assert.ok(getErrors("fix(readme): 修复文档格式").length > 0);
  assert.ok(getErrors("docs: 更新项目文档").length > 0);
  assert.ok(getErrors("test: 补充审批测试").length > 0);
  assert.ok(getErrors("fix: 修复文档格式\n\n补充正文说明").length > 0);
});

test("拒绝非中文、空泛描述、序号和句末标点", () => {
  assert.ok(getErrors("fix: Update README wording").length > 0);
  assert.ok(getErrors("fix: WIP").length > 0);
  assert.ok(getErrors("fix: 1. 修复文档格式").length > 0);
  assert.ok(getErrors("fix: 修复文档格式。").length > 0);
});

test("拒绝冒号后缺少空格", () => {
  assert.ok(getErrors("fix:修复文档格式").length > 0);
});

test("忽略 Git 注释和末尾换行但拒绝正文", () => {
  assert.deepEqual(getErrors("fix: 修复提交信息校验\n\n# Please enter the commit message").length, 0);
  assert.ok(getErrors("fix: 修复提交信息校验\n\n实际正文").length > 0);
});
