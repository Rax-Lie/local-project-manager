# 通用项目管理

面向 VS Code 本地工作区的通用项目管理扩展。它把“管理根目录”“项目模板”“项目台账”和“工作区文件夹”组合起来：项目目录只能由扩展新建，创建后自动加入当前 `.code-workspace`，并通过 SQLite 维护可搜索的状态。

当前版本 `0.1.0` 已完成计划中的 P1–P7：包括根初始化故障恢复、模板 CRUD、项目归档与恢复、暂存目录建议和 Markdown 本地链接检查。`npm run verify` 的 108 项测试通过；VSIX 已在隔离配置中安装，并在 VS Code 1.121.0 扩展宿主中验证激活和相关命令。

## 环境要求

- VS Code `1.121.0` 或更高版本（扩展宿主内置 Node 22.22，已包含 `node:sqlite`）。
- 本地 Windows 工作区；首期不承诺跨平台、远程工作区或虚拟工作区。
- 无需安装额外的 Node.js 或原生模块。扩展优先使用 VS Code 内置 Node 运行 CLI；也可以在设置中指定外部 Node（>= 22.13）。
- 目标工作区必须是已保存的 `.code-workspace` 文件，单文件夹窗口不能初始化管理根。

## 快速开始

1. 用 VS Code 打开并保存一个 `.code-workspace` 工作区文件。
2. 运行命令 **项目管理: 初始化管理根**，选择一个**空目录**作为管理根。
   - 扩展会生成 `.pm/pm.json`、`.pm/pm.sqlite`、模板目录、备份目录以及 `inbox` / `projects` / `archive` 分区。
   - 目录非空时只生成带阻塞警告的计划，不会写入任何文件。
3. 运行 **项目管理: 新建项目**，选择模板、填写字段并确认预览。
   - 项目目录创建在 `projects/<slug>`。
   - 项目会作为独立文件夹加入当前 `.code-workspace`，显示名称使用中文项目名。
4. 在活动栏的“项目管理”视图中按状态查看项目，或运行 **项目管理: 搜索项目**。

> 管理根目录本身不会作为工作区文件夹加入，避免容器与子项目重叠。若目标项目位于一个已打开的工作区文件夹内，扩展会拒绝添加并提示先移除父文件夹。

## 命令

| 命令 | 作用 |
|---|---|
| `项目管理: 初始化管理根` | 选择空目录，预览并初始化 `.pm`、分区、模板和数据库；中断后可检查并安全恢复 |
| `项目管理: 新建项目` | 模板驱动填写字段，预览 slug/路径/目录骨架，创建后同步工作区 |
| `项目管理: 管理项目模板` | 创建、查看/编辑、启停或软删除项目模板 |
| `项目管理: 保存模板草稿` | 校验并保存当前模板 JSON 草稿 |
| `项目管理: 搜索项目` | 按关键词和状态搜索，查看字段与路径，进入文件模板或归档流程 |
| `项目管理: 应用 Markdown 文件模板` | 渲染变量、预览内容、拒绝覆盖同名文件并写入 |
| `项目管理: 完成待同步项目` | 检查未完成操作，安全推进可确认的步骤并补做工作区同步 |
| `项目管理: 检查未完成操作` | 只读检查 journal、目录、数据库和工作区的一致性；可执行安全恢复 |
| `项目管理: 归档项目` | 将活动项目移动到 `archive/<slug>`，更新台账并从工作区移除 |
| `项目管理: 恢复归档项目` | 预览并将归档目录恢复到 `projects/<slug>`，重新添加到当前工作区 |
| `项目管理: 扫描暂存项目建议` | 扫描用户选择目录的一级子目录，可确认新建独立项目工作文件夹或忽略；建议分是可解释的启发式分值 |
| `项目管理: 检查 Markdown 本地链接` | 检查当前 Markdown 文件中的常见本地链接并定位问题 |
| `项目管理: 刷新项目列表` | 重新读取管理根与项目 |
| `在资源管理器中显示项目` | 从树视图或搜索中定位项目目录 |
| `复制项目信息` | 复制项目名称、slug、路径、模板、字段到剪贴板 |

## 目录与数据布局

```text
<管理根>/
├─ .pm/
│  ├─ pm.json                 根配置（唯一根配置真相）
│  ├─ pm.sqlite               项目台账与操作 journal（唯一项目真相）
│  ├─ templates/*.json        模板内容真相；数据库只保存可重建索引
│  └─ backups/                迁移前备份
├─ inbox/                     可配置的收件箱分区
├─ projects/<slug>/           新建项目；包含 .pm-project.json 只读快照
└─ archive/<slug>/            归档项目
```

- 所有时间使用 UTC ISO-8601。
- 相对路径统一保存为 `/` 分隔；写入文件系统时由适配器转换成本机路径。
- `pm.json` 的 `workspaceUri` 绑定目标工作区；扩展只会修改当前打开且完全匹配的工作区。
- 中文项目名无法转写为 ASCII 时，目录 slug 使用显示名称的稳定哈希（如 `project-1a2b3c4d`），不把多字节别名写入磁盘路径；同名冲突自动追加 `-2`、`-3`。

根配置示例：

```json
{
  "schemaVersion": 1,
  "rootId": "root_...",
  "displayName": "我的管理根",
  "workspaceUri": "file:///D:/work/my.code-workspace",
  "configRevision": 1,
  "partitions": [
    { "id": "inbox", "name": "收件箱", "relativePath": "inbox" },
    { "id": "projects", "name": "项目", "relativePath": "projects" },
    { "id": "archive", "name": "归档", "relativePath": "archive" }
  ],
  "slugRules": {
    "pattern": "^[a-z0-9][a-z0-9-]{0,63}$",
    "maxLength": 64,
    "lowercase": true
  }
}
```

## 模板

模板是 `.pm/templates/*.json` 文件。首次初始化会写入两个内置模板：

- `standard`：说明、负责人、开始日期、优先级；目录 `docs`、`docs/notes`、`assets`；`README.md`。
- `blank`：无字段；目录 `docs`；`README.md`。

运行 **项目管理: 管理项目模板** 可创建、编辑、启用/停用和删除模板。创建或编辑会打开 JSON 草稿；编辑后运行 **项目管理: 保存模板草稿**。模板 ID 使用小写字母开头，最多 64 个小写字母、数字或连字符。新模板从 revision 1 开始，每次编辑必须将 revision 加 1，服务端同时校验 expectedRevision，拒绝过期草稿。保存会先校验模板 schema；更新使用同目录临时文件替换，避免留下半写入 JSON。

删除是软删除：模板会被停用，定义文件继续保留，便于恢复，也不影响已有项目保存的模板快照。停用模板不能用于新建项目或新增 Markdown 文件；可在模板管理中重新启用。

示例：

```json
{
  "id": "standard",
  "revision": 1,
  "displayName": "通用项目",
  "fields": [
    {
      "id": "description",
      "label": "项目说明",
      "type": "text",
      "required": false,
      "defaultValue": ""
    },
    {
      "id": "priority",
      "label": "优先级",
      "type": "choice",
      "required": true,
      "choices": ["低", "中", "高"],
      "defaultValue": "中"
    }
  ],
  "directoryBlueprint": ["docs", "assets"],
  "markdownTemplates": [
    {
      "id": "readme",
      "displayName": "项目 README",
      "targetPath": "README.md",
      "content": "# ${project.displayName}\n\n${field.description}\n"
    }
  ]
}
```

字段类型：`text`、`number`、`date`（YYYY-MM-DD）、`boolean`、`choice`。所有字段值和目录路径在计划阶段校验；未知字段、路径穿越、Windows 保留名和 `.pm` 路径都会被拒绝。

Markdown 变量：

| 变量 | 含义 |
|---|---|
| `${project.displayName}` | 项目显示名称 |
| `${project.slug}` | 目录 slug |
| `${project.relativePath}` | 根内相对路径 |
| `${project.createdAt}` | 创建时间 |
| `${root.displayName}` / `${root.rootId}` | 管理根信息 |
| `${field.<id>}` | 模板字段值 |
| `${date.today}` / `${date.now}` | UTC 日期/时间 |

未知变量会在预览阶段被拒绝，不写入文件。写入使用 no-replace；目标同名时停止，绝不覆盖用户内容。

## 设置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `projectManager.nodePath` | 空 | 指定运行 CLI 的 Node 路径，要求 >= 22.13；留空时优先使用 VS Code 内置 Node，再回退 PATH 中的 `node` |
| `projectManager.requestTimeoutMs` | `120000` | 单次 CLI 请求超时，5–600 秒 |
| `projectManager.maxSearchResults` | `100` | 搜索结果上限 |
| `projectManager.partitions` | 默认三分区 | 初始化时使用的分区名称和根内相对路径；必须是 inbox/projects/archive 各一项 |
| `projectManager.slugRules` | 见上 | slug 正则、最大长度和大小写规则 |

如果启动 CLI 失败，扩展会展示 `RUNTIME_UNAVAILABLE` 并给出“打开运行时设置”按钮。

## 安全与恢复

- 所有创建/归档先由 CLI 生成只读计划，展示摘要，用户确认后才执行。
- 计划摘要绑定输入、根配置版本、模板版本、模板内容哈希和目标；确认后任何变化都会拒绝旧计划。
- 文件系统、SQLite 和 Workspace API 不共享事务，复合操作先写 journal，再逐步推进；中断后通过 **检查未完成操作** 对照磁盘、数据库和工作区恢复。
- 文件写入使用 `wx` 独占创建；移动使用 no-replace；只删除空目录；不自动递归删除或覆盖用户内容。
- 工作区更新失败时保留 `awaiting_workspace`，项目目录不会被删除，可运行 **完成待同步项目** 重试。
- 根目录、分区或项目路径中的符号链接/junction 会被拒绝，防止路径逃逸。
- 归档移动后若工作区移除失败，项目保持“归档中”，修复工作区后可重试完成。

## 开发

```powershell
npm run check     # 语法、行数、清单、阻塞式 API 检查
npm test          # 单元 + 集成 + 扩展适配测试（Node 内置 test runner）
npm run verify    # check + test
npm run package   # 使用仓库内打包器生成 VSIX，无第三方打包依赖
```

测试使用临时目录和合成的 `.code-workspace`，覆盖根初始化及 16 个崩溃边界恢复、项目创建、模板 CRUD/版本冲突、搜索分页、文件模板、归档与恢复、暂存扫描/迁移/决策持久化、Markdown 本地链接边界、协议边界、路径/slug 规则以及 WorkspaceAdapter 测试替身；当前共 108 项测试通过。

CLI 协议：stdin 一个 UTF-8 JSON 请求，stdout 一条 JSON 响应，诊断写 stderr；协议版本、请求 ID、请求/响应字节上限、退出码和错误码均在两端校验。完整协议与数据流见仓库中的 `docs/整体开发指南.md`。

## 当前限制

- 仅面向本地 Windows；未实现远程/虚拟工作区、已有目录导入和历史项目批量登记。
- 归档和恢复均要求确认计划；暂不支持跨卷移动，冲突或状态不确定时停止并要求人工检查。
- 暂存建议只读取用户选择目录的一级子目录名称和标记文件名；确认后通过常规模板流程创建新的项目工作文件夹，原目录不导入、不移动。
- Markdown 本地链接检查覆盖常用 inline/reference 链接和带引号的 HTML `href/src`，不承诺完整 CommonMark 解析或附件管理。
- 不含多人并发编辑；同一数据库的并发写通过 SQLite busy timeout 和唯一约束保护。

## 许可

MIT，见 [LICENSE](LICENSE)。
