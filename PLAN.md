# CMCU 项目管家（PM 插件）设计规划

> 版本 v0.9（规划稿） · 2026-10-27 · 状态：**待评审**
> 适用目录：`D:\Files\CMCU`（546,380 个文件 / 约 801 GB / 最深 22 层）
> 本文只描述设计，不含实现；落地范围见第 13 节。

---

## 0. 一句话

把"文件夹结构"变成"可查询的项目台账"：**磁盘全英文、界面全中文、所有写操作可撤销**，用一个零依赖的 VS Code 扩展 + 一个 Node CLI 引擎实现。

---

## 1. 背景

现状扫描结论（真机实测）：

| 指标 | 数值 |
|---|---|
| 文件 / 目录 | 546,380 / 约 53,000 |
| 总体积 | 约 801 GB |
| 命名体系 | 4 套并存：编号式 18.6 万文件、日期式 16.7 万、自由命名 14.9 万、按年分桶 4.5 万 |
| 重复文件 | 同名同大小 ≥20 MB 共 390 组、753 个多余副本、约 80 GB |
| 开发垃圾 | .git 26.1 GB、.venv 15.8 GB、__pycache__ 4.4 万文件 |
| 临时目录 | temp / 中间检 / 新建文件夹 合计 48 GB |
| 项目台账 | **不存在**，状态全靠人脑 |

自动识别原型已跑通：用 200 行启发式规则可识别 **171 个项目、覆盖 56% 体积**（陈耀坤目录 100% 可解析，魏伏佳目录仅 11%）。这说明：**能解析多少，取决于命名规范，而不是工具强弱。**

---

## 2. 目标与范围

### 2.1 本期六项功能

| # | 功能 | 一句话定义 |
|---|---|---|
| 1 | 项目模板管理 | 模板 = **目录骨架**（不含正文），可新建/编辑/删除/套用 |
| 2 | 文件模板管理 | 独立产品线：新建**文件**时套正文（md / docx 模板） |
| 3 | 未分类文件管理 | 暂存夹 + 归类建议，人工确认才移动 |
| 4 | 项目快速添加 | 选模板 → 填字段 → 预览 → 生成项目 |
| 5 | 项目类型转换 | 换模板（含"单期 → 分期"包装），不批量 |
| 6 | 根目录初始化 | 建 SQLite 台账 + `.pm` 配置 + code-workspace + 骨架 |

### 2.2 明确不做（本期）

- ❌ Office 文件**编辑**（只做后续预览，本期不涉及）
- ❌ 多人协作 / 权限 / 并发保护（单人使用）
- ❌ 历史项目反向登记（用户后续自行导入，本期只预留命令）
- ❌ 批量类型转换
- ❌ 自动移动/自动删除任何业务文件
- ❌ 资源管理器里把子目录名换成中文（VS Code 无此能力，见 5.4）

---

## 3. 决策记录

### 3.1 已确认（用户已答复）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 使用人数 | 单人，不做并发控制 |
| D2 | 模板范围 | 只做目录骨架；文件模板另立一项 |
| D3 | 未分类处理 | 给出建议，未归类统一进暂存夹 |
| D4 | md 附件语法 | 支持 CommonMark + GFM + HTML 标签全语法 |
| D5 | 历史登记 | 暂缓，用几天后自行导入 |
| D6 | 类型枚举 | **类型 = 模板**，不硬编码；支持单期 → 多期 |
| D7 | 转换方式 | 单个转换，不批量 |
| D8 | 初始化含义 | 新建 SQLite + code-workspace，让插件识别根目录 |
| D9 | 路径语言 | 磁盘路径全英文（UPPER_SNAKE）；输入中文则转拼音 |
| D10 | 显示语言 | 界面显示中文别名 |
| D11 | 工作区别名 | `.code-workspace` 的 `folders[].name` 用作中文别名 |

### 3.2 待确认（本稿按"推荐值"编写，评审可改）

| # | 问题 | 推荐值 | 影响 |
|---|---|---|---|
| Q1 | 命名形式 | **方案 C（混合）**：`2026_01_CQ_CHENGTOU_GONGZUFANG` | 影响所有新建路径 |
| Q2 | 文件名语言 | **目录英文、文件名保留中文** | 影响可读性与脚本兼容 |
| Q3 | 拼音来源 | **三级方案**（别名表 → 内置词表 300 条 → 首字母回退 + 弹窗确认） | 无网络环境唯一可行解 |
| Q4 | 存量 170 个中文目录 | **存量不动，新建按新规** | 迁移风险与脚本兼容性 |
| Q5 | 骨架目录名 | 沿用 `陈耀坤` 那套语义：需求/方案/数据/代码/交付/归档 | 迁移摩擦最小 |
| Q6 | 分期形态 | **共享一套 + `01_PHASE_1` 子目录** | 避免代码与数据按期复制 |

---

## 4. 根目录形态

```text
D:\Files\CMCU\
├─ .pm\                      ← 根标记（存在即认为已初始化）
│   ├─ pm.json               ← 根配置：目录约定、命名方案、显示别名
│   ├─ pm.sqlite             ← 台账（唯一真相库，CLI 维护）
│   ├─ pm-cli.js             ← 命令行引擎（扩展通过子进程调用）
│   ├─ aliases.json          ← 中文 → 英文映射表（越用越全）
│   ├─ rules.json            ← 暂存归类规则
│   ├─ templates\            ← 项目模板（目录骨架）
│   │   └─ CLIENT_PROJECT\template.json
│   ├─ file-templates\       ← 文件模板（正文）
│   │   ├─ manifest.json
│   │   └─ MEETING_MINUTES.md
│   └─ journal\             ← 操作日志（可撤销）
├─ 00_INBOX\                 ← 暂存（显示：暂存）
├─ 10_PROJECT\               ← 项目（显示：项目）
├─ 90_ARCHIVE\               ← 归档（显示：归档）
└─ CMCU.code-workspace       ← 工作区（含中文别名与排除规则）
```

**根标记判定**：扩展激活时从各工作区文件夹向上查找 `.pm/pm.json`，找到即视为根；找不到则提示"是否初始化"。

---

## 5. 命名与别名规范

### 5.1 三层命名

| 层 | 字段 | 语言 | 可变性 | 用途 |
|---|---|---|---|---|
| 稳定标识 | `id` = `P-2026-013` | ASCII | **永不变** | 台账主键、日志、撤销 |
| 磁盘名 | `slug` = `2026_01_CQ_CHENGTOU_GONGZUFANG` | ASCII 大写蛇形 | 转换/改期时可变 | 实际路径 |
| 显示名 | `alias` = `重庆城投集团公租房智能化改造` | 中文 | 随时可改 | 所有 UI |

**原则：命中用 id，落盘用 slug，展示用 alias。** 三者互相能对上，是"中文界面 + 英文路径"长期稳定的唯一办法。

### 5.2 slug 生成算法（方案 C）

```text
输入：  2026-01 | 重庆 | 城投集团 | 公租房智能化改造
        ↓ 城市查内置缩写表（40 条）
        ↓ 客户查 aliases.json，未命中则首字母回退 + 弹窗确认
        ↓ 主题查 aliases.json / 内置词表，未命中同上
输出：  2026_01_CQ_CHENGTOU_GONGZUFANG
```

规则细节：

- 段落分隔用 `_`，日期段同样用 `_`（`2026_01`），保证整串只有一种分隔符；
- 仅允许 `A-Z 0-9 _`，长度上限 64 字符；
- 撞名时追加 `_2`、`_3`；同音不同字靠别名表区分；
- 城市缩写内置表：`重庆 CQ`、`安徽 AH`、`浙江 ZJ`、`江苏 JS`、`上海 SH`、`北京 BJ`、`天津 TJ`、`广东 GD`、`四川 SC`、`河南 HN`、`湖北 HB`、`湖南 HUN`、`山东 SD`、`陕西 SX`、`福建 FJ`、`重庆下辖区县按拼音首字母` …（实现时补齐 40 条）。

### 5.3 别名表 `.pm/aliases.json`

```json
{
  "version": 1,
  "cities":  { "重庆": "CQ", "安徽": "AH", "浙江": "ZJ" },
  "terms": {
    "城投集团": "CHENGTOU",
    "公租房智能化改造": "GONGZUFANG",
    "富乐德": "FULEDE",
    "三一筑工": "SANYI"
  }
}
```

三级转换的优先级：**terms → 内置词表 → 首字母回退（并弹窗询问，答案写回 terms）**。

### 5.4 显示层与硬限制

| 位置 | 显示 | 机制 |
|---|---|---|
| Explorer 顶层（工作区根） | **中文**：暂存 / 项目 / 归档 | `folders[].name` ✅ 官方支持 |
| Explorer 子目录 | ASCII + **悬停中文 tooltip** | `FileDecorationProvider.tooltip` |
| PM 专用视图 | **中文** | 自绘 `TreeDataProvider` |
| 编辑器标签页 | **中文** | `workbench.editor.customLabels`（扩展自动生成，仅近 90 天活跃项目） |
| 命令面板 / 快速选择 | **中文可搜** | QuickPick `description` 放 slug |
| 最近打开列表 | ASCII 文件名 | ❌ 无法修改 |

> **硬限制**：VS Code 无法修改资源管理器里子目录的显示名。要"全中文"只能自绘文件树，代价是丢失原生右键/拖拽/打开方式，**不采用**。

---

## 6. 数据模型（SQLite）

`.pm/pm.sqlite`，WAL 模式。DDL：

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS template (
  code    TEXT PRIMARY KEY,          -- CLIENT_PROJECT
  alias   TEXT NOT NULL,             -- 客户项目
  phases  INTEGER NOT NULL DEFAULT 0,
  naming  TEXT,                      -- {YYYY}_{MM}_{CITY}_{CLIENT}_{TOPIC}
  dirs    TEXT NOT NULL,             -- JSON: [{name,label}]
  sort    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project (
  id               TEXT PRIMARY KEY,            -- P-2026-013
  alias            TEXT NOT NULL,               -- 中文显示名
  slug             TEXT NOT NULL UNIQUE,        -- 磁盘名
  path             TEXT NOT NULL UNIQUE,        -- 相对根路径
  template         TEXT NOT NULL REFERENCES template(code),
  parent_id        TEXT REFERENCES project(id), -- 分期时指向父项目
  phase_index      INTEGER,                     -- 第几期
  city TEXT, client TEXT, topic TEXT,
  owner TEXT, contract_no TEXT,
  status           TEXT NOT NULL DEFAULT 'active', -- active|paused|done|archived
  created_at TEXT, updated_at TEXT, last_activity_at TEXT,
  size_bytes INTEGER DEFAULT 0, file_count INTEGER DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS phase (
  project_id  TEXT NOT NULL REFERENCES project(id),
  index_no    INTEGER NOT NULL,
  label       TEXT,                 -- 一期 / 二期
  started_at  TEXT, ended_at TEXT,
  contract_no TEXT,
  PRIMARY KEY (project_id, index_no)
);

CREATE TABLE IF NOT EXISTS file_index (
  path       TEXT PRIMARY KEY,
  ext        TEXT, size INTEGER, mtime INTEGER,
  project_id TEXT,
  role       TEXT   -- project|inbox|system|attachment|unclassified
);

CREATE TABLE IF NOT EXISTS inbox_item (
  path              TEXT PRIMARY KEY,
  size INTEGER, mtime INTEGER,
  suggestion_path   TEXT,
  suggestion_project TEXT,
  score             REAL,
  reason            TEXT,
  state             TEXT NOT NULL DEFAULT 'pending', -- pending|moved|ignored
  updated_at        TEXT
);

CREATE TABLE IF NOT EXISTS journal (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  op      TEXT NOT NULL,
  payload TEXT NOT NULL,           -- JSON，含 from/to
  undone  INTEGER NOT NULL DEFAULT 0
);
```

索引：`project(status)`、`project(template)`、`file_index(project_id)`、`inbox_item(state)`。

---

## 7. 模板

### 7.1 项目模板（目录骨架）

```jsonc
// .pm/templates/CLIENT_PROJECT/template.json
{
  "code": "CLIENT_PROJECT",
  "alias": "客户项目",
  "phases": false,
  "naming": "{YYYY}_{MM}_{CITY}_{CLIENT}_{TOPIC}",
  "dirs": [
    { "name": "01_REQUIREMENT", "label": "需求与交流" },
    { "name": "02_PROPOSAL",    "label": "方案与报价" },
    { "name": "03_DATA",        "label": "数据" },
    { "name": "04_CODE",        "label": "代码" },
    { "name": "05_DELIVERABLE", "label": "交付物" },
    { "name": "06_ARCHIVE",     "label": "归档" }
  ],
  "files": [                      // 可选：骨架期生成占位文件（内容来自文件模板）
    { "template": "PROJECT_README", "to": "README.md" }
  ]
}
```

- 模板目录名本身也用 ASCII（`CLIENT_PROJECT`），中文放 `alias`；
- 新建模板 = 在 PM 视图里勾选若干文件夹 → 反向生成 `dirs`（只取结构，不取内容）；
- 模板可整目录拷贝分享（团队复用），本期单人使用只存本地。

### 7.2 文件模板（独立一项）

```jsonc
// .pm/file-templates/manifest.json
{
  "version": 1,
  "items": [
    { "code": "MEETING_MINUTES", "alias": "会议纪要", "file": "MEETING_MINUTES.md", "ext": ".md",
      "vars": ["title", "date", "attendees"] },
    { "code": "WEEKLY_REPORT",   "alias": "项目周报", "file": "WEEKLY_REPORT.md",   "ext": ".md",
      "vars": ["project", "week", "owner"] }
  ]
}
```

- 正文用 `{{var}}` 占位；新建时弹表单填值；
- 本期先支持 `.md`；`.docx` 模板留接口，等 Office 预览阶段一起做。

---

## 8. 六项功能详设

### F1 项目模板管理

| 项 | 内容 |
|---|---|
| 入口 | PM 视图 → 模板区 → 右键；命令面板 `PM: 新建项目模板` |
| 新建 | 选一个已有目录（或手工填）→ 抽取 `dirs`（只取目录与层级）→ 填 alias/code → 写入 `.pm/templates` → 同步 SQLite `template` 表 |
| 编辑 | 打开 `template.json`（带 JSON Schema 校验），保存即生效 |
| 删除 | 校验"无项目引用"，否则提示改为停用 |
| 验收 | 模板改动后新建项目，目录结构与模板完全一致；中文标签在树里正确显示 |

### F2 文件模板管理

| 项 | 内容 |
|---|---|
| 入口 | 命令面板 `PM: 从文件模板新建`；资源管理器右键 |
| 流程 | 选模板 → 填变量 → 在当前目录生成文件 |
| 管理 | 模板文件放在 `.pm/file-templates/`，编辑即所见（没有二次格式） |
| 验收 | 生成文件中的 `{{var}}` 全部被替换，无残留占位 |

### F3 未分类文件管理（暂存）

| 项 | 内容 |
|---|---|
| 入口 | PM 视图 → 暂存 (N) |
| 扫描范围 | `00_INBOX` 全量 + 根目录第一层散件（**不扫全盘**，避免 54 万文件开销） |
| 建议引擎 | ① 文件名关键词匹配项目 alias/slug（模糊）② 扩展名 + 目标模板的目录语义 ③ 时间邻近（与某项目最近活动同月加权） |
| 展示 | 每个条目：文件名 → 建议目标 + 置信度 + 理由（如"文件名含'曙光湖'，命中项目 …"） |
| 动作 | 确认移动 / 改选目标 / 忽略 / 就地新建项目 |
| 安全 | **默认不移动**；移动走 journal，可一键撤销 |
| 验收 | 对现有 18 个根目录散件给出建议，人工判定准确率 ≥70%，零误移动 |

### F4 项目快速添加

| 项 | 内容 |
|---|---|
| 入口 | PM 视图标题栏 `+`；命令面板 |
| 流程 | 选模板 → 依次填 城市 / 客户 / 主题 / 负责人（可选合同号）→ **实时预览 slug 与目录树** → 可手改 slug → 确认创建 |
| 产物 | 目录骨架 + `_project.json` + SQLite 记录 + workspace 别名同步 + 打开 README |
| 安全 | 创建前必显示"将要生成什么"；只允许在 `10_PROJECT` 下创建 |
| 验收 | 30 秒内建出一个规范项目，磁盘/数据库/视图三处一致 |

### F5 项目类型转换

| 项 | 内容 |
|---|---|
| 入口 | 项目节点右键 → 转换类型 |
| 类型 | 目标模板列表（来自 `template` 表），不做批量 |
| 单期 → 分期 | 目标模板 `phases=true` 时：现有内容整体移入 `01_PHASE_1/`，再补 `02_PHASE_2/` 空骨架，写入 `phase` 表 |
| 补骨架 | 只补缺失目录，**不删不改**已有内容 |
| 安全 | 生成 dry-run 计划（旧路径 → 新路径逐条列出）→ 确认 → 执行 → journal 记录 → `PM: 撤销` 可回退 |
| 验收 | 转换后 `path`/`slug` 更新、`alias` 不变、内容零丢失 |

### F6 根目录初始化

| 项 | 内容 |
|---|---|
| 入口 | 命令面板 `PM: 初始化根目录` |
| 动作 | 建 `.pm`（配置/DB/模板/日志）→ 建 `00_INBOX / 10_PROJECT / 90_ARCHIVE` → 生成 `CMCU.code-workspace`（含中文别名与排除规则）→ 建默认模板三套 → 写首个 journal |
| 幂等 | 已存在则**只补缺**，不覆盖；`--force` 才重建 |
| 诊断 | `PM: 检查根目录` 输出缺项、命名违规、超长路径、junction、锁文件数 |
| 安全 | 对已存在的 801 GB 目录**默认只出报告**，需明确确认才创建骨架 |
| 验收 | 临时空目录一键成型；真实目录只产出报告且零改动 |

---

## 9. 分期项目的模型

一期项目 `parent_id = NULL`。转分期后：

```text
2025_12_AH_FULEDE_MAPPING\
├─ _project.json            ← 共享元数据（客户、代码库、数据位置）
├─ 01_PHASE_1\              ← 原内容整体移入
│   ├─ 01_REQUIREMENT … 06_ARCHIVE
└─ 02_PHASE_2\              ← 新建空骨架
```

**理由**：代码库与数据集按期复制会线性膨胀（当前已为重复存储付 80 GB 代价）。分期共享一套物理内容，每期的合同号、起止时间记在 `phase` 表，不影响独立核算。

---

## 10. 架构与技术选型

```text
┌────────────────────────────┐
│ VS Code 扩展（纯 JS，零依赖） │  UI / 树视图 / Webview / 命令
└───────────┬────────────────┘
            │ child_process（约 80ms/次）
┌───────────▼────────────────┐
│ .pm/pm-cli.js              │  业务逻辑：台账、模板、暂存、附件、迁移
│ 由系统 node v24 执行        │  唯一写 SQLite 的进程
└───────────┬────────────────┘
            │ node:sqlite（内置，无需编译）
┌───────────▼────────────────┐
│ .pm/pm.sqlite              │  台账（可重建）
└────────────────────────────┘
```

| 决策 | 选择 | 理由 |
|---|---|---|
| 语言 | 纯 JavaScript（CommonJS） | 无构建步骤、无 `@types/vscode` 依赖、VS Code 直接加载 |
| SQLite 驱动 | 系统 node v24 的 `node:sqlite`（**已实测可用**） | 扩展宿主 Node 版本不保证支持该模块；子进程规避 |
| 原生模块 | 一律不用 | 无网络时 `npm install` 会失败，`better-sqlite3` 这类直接卡死 |
| 扫描 | CLI 全量/增量，可中断 | Extension Host 单进程，扫 54 万文件会假死 |
| 前端 | 原生 TreeView + 少量 Webview | 单人使用，不需要框架 |

---

## 11. 安全与撤销

1. **只读优先**：所有会改动磁盘的命令，先产出"计划"（旧→新逐条），确认后执行；
2. **journal 全覆盖**：每次移动/重命名写一条记录（内容含 from/to），`PM: 撤销` 逆操作最近 N 条；
3. **不删业务文件**：删除动作仅限空目录与缓存；用户文件只能移动；
4. **跨盘保护**：rename 失败（跨卷）时报错并停止，不做 copy+delete 的隐式降级；
5. **占用检测**：移动前检查目标是否被 Office 占用（`~$` 锁文件、可写探测）；
6. **范围锁**：所有写操作限制在根目录内，路径前缀校验，禁止越界。

---

## 12. 性能约束与已知限制

| 约束 | 数值/表现 | 应对 |
|---|---|---|
| 全量索引 | 54.6 万文件，一次性约 10–20 分钟 | 后台任务 + 进度条 + 可中断；日常用增量（mtime 比对） |
| CLI 单次查询 | 约 80 ms | 可接受；批量操作合并为一次调用 |
| 长路径 | 已有 22 层，接近 260 字符 | 统一加 `\\?\` 前缀；新建时校验长度上限 |
| junction | 3 个（`node_modules\lucide` 等） | 扫描跳过 ReparsePoint |
| Office 占用 | 166 个 `~$` 锁文件 | 移动前检测，失败给出清单 |
| 大文件 | 单文件最大 845 MB | 索引只记元数据，不读内容 |
| 拼音 | 无网络、无 npm 包 | 三级方案（5.3） |
| 资源管理器 | 子目录名无法中文 | 见 5.4，接受限制 |

---

## 13. 阶段计划与验收

| 阶段 | 内容 | 验收标准 | 估时 |
|---|---|---|---|
| **P0** | 根初始化 + `.pm` 配置 + SQLite + `pm-cli.js` 骨架 + workspace 生成 | 临时目录一键成型；真实目录只出报告 | 1 天 |
| **P1** | 模板管理（F1）+ 快速添加（F4） | 30 秒建项目，三处一致 | 1.5 天 |
| **P2** | 文件模板（F2）+ 类型转换（F5）+ 分期 | 转换可撤销，内容零丢失 | 1.5 天 |
| **P3** | 暂存与归类建议（F3） | 18 个散件准确率 ≥70%，零误移动 | 1.5 天 |
| **P4** | md 附件管理 + 别名/标签页同步 | 真实 md 上跑出坏链/孤儿报告 | 1 天 |
| **P5** | 打包 `.vsix` + 使用说明 | `code --install-extension` 即装即用 | 0.5 天 |

**P0 红线**：全程在测试副本上验证；对 `D:\Files\CMCU` 只读、只出报告。

---

## 14. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 拼音转换误判（同音字） | slug 错、后续改名 | 别名表把关 + 创建前可手改 |
| 存量中文目录与新规混杂 | 观感割裂 | 存量不动，新规只管新建 |
| 英文路径导致旧脚本失效 | 自动化断链 | 不清算旧路径；新项目单独目录 |
| VS Code 更新导致 API 变更 | 扩展失效 | 只用稳定 API；CLI 与 UI 解耦 |
| 误移动大量数据 | 数据事故 | dry-run + journal + 撤销 + 范围锁 |
| 用户忘记跑索引 | 台账过期 | 激活时检测 DB 时间戳，超过 24h 提示 |

---

## 附录 A：命令清单（预留）

| 命令 ID | 标题 |
|---|---|
| `pm.root.init` | PM: 初始化根目录 |
| `pm.root.check` | PM: 检查根目录 |
| `pm.root.syncWorkspace` | PM: 同步工作区别名 |
| `pm.project.new` | PM: 新建项目 |
| `pm.project.convert` | PM: 转换项目类型 |
| `pm.project.addPhase` | PM: 添加项目分期 |
| `pm.project.open` | PM: 打开项目（中文搜索） |
| `pm.template.new` | PM: 新建项目模板 |
| `pm.fileTemplate.new` | PM: 从文件模板新建 |
| `pm.inbox.scan` | PM: 扫描暂存 |
| `pm.inbox.accept` | PM: 采纳归类建议 |
| `pm.md.attach` | PM: 插入附件 |
| `pm.md.check` | PM: 检查 md 附件 |
| `pm.undo` | PM: 撤销上一步 |
| `pm.index.rebuild` | PM: 重建索引 |

## 附录 B：`pm.json` 示例

```jsonc
{
  "version": 1,
  "root": true,
  "displayName": "中机中联 AI 中心",
  "dirs": { "inbox": "00_INBOX", "projects": "10_PROJECT", "archive": "90_ARCHIVE", "system": ".pm" },
  "alias": { "00_INBOX": "暂存", "10_PROJECT": "项目", "90_ARCHIVE": "归档" },
  "naming": { "scheme": "C", "pattern": "{YYYY}_{MM}_{CITY}_{CLIENT}_{TOPIC}" },
  "attachments": { "dirPattern": "{name}.assets" },
  "ui": { "customLabels": true, "customLabelsMaxProjects": 60 }
}
```

## 附录 C：本期不做的功能（后续候选）

1. Office 文档只读预览（docx/xlsx/pdf）
2. 历史目录反向登记与批量迁移
3. 重复文件检测与清理
4. 项目看板 / 甘特 / 周报自动生成
5. 多人协作（届时建议引入 Gitea，而非扩展内实现）
