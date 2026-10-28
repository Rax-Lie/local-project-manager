# Changelog

## 0.1.0 — 2026-10-28

首个可安装 MVP：

- 管理根选择、空目录检查、`.pm/pm.json` 配置、SQLite schema v1、模板/备份目录和可配置分区。
- 模板 schema 校验、schema 驱动字段输入、slug/路径预览、独占创建项目目录、元数据快照和 provisioning/active 状态机。
- 项目按中文显示名加入当前 `.code-workspace`，重复同步幂等；工作区不匹配时拒绝修改。
- Markdown 文件模板变量渲染、预览、同名不覆盖写入。
- 文本/状态/字段过滤搜索，稳定顺序和绑定查询的游标分页。
- 操作 journal、启动检查、幂等重试、`needs_recovery` 报告和安全恢复。
- 基础归档：no-replace 移动、台账更新、工作区移除与中断恢复。
- VSIX 打包、`npm run check`、77 项自动化测试和离线安装验证。

已知限制见 README“当前限制”。
