# 求职助手开发手册

## 1. 产品边界

这是一个 macOS 优先的单用户本地 Web 应用。服务只监听 `127.0.0.1`，没有账号、云数据库或公开 API。产品主循环是：

`收集岗位 → 核对事实 → 做投入判断 → 明确下一步 → 准备材料 → 推进招聘节点 → 记录结果与复盘`

实现新功能时应优先缩短这个闭环，不应把应用扩展成通用 CRM 或单纯的数据录入系统。

应用显示名已由“求职工作台”改为“求职助手”；数据库目录 `ZhaopinAssistant`、服务标签 `com.local.zhaopin-assistant`、启动器 Bundle ID、钥匙串标识和 manifest id 保持不变。`scripts/app-bundle-name.mjs` 只迁移当前项目生成的旧应用入口，校验生成的 plist / 可执行入口及项目路径，拒绝同名其他应用、符号链接和新旧入口共存；中断后可重试。不迁移业务数据，不自动改写用户的 Dock 配置。

## 2. 技术栈与目录

- Next.js App Router + React + TypeScript；
- Tailwind CSS 4 与本地 shadcn 组件；
- SQLite、better-sqlite3 与 Drizzle ORM；
- Vitest 单元测试与独立 Playwright 浏览器回归；
- macOS `osascript` 用于文件选择与系统通知，`open` 用于打开已校验的材料，`security` 用于钥匙串读写。

主要目录：

- `app/`：页面入口与内部 Route Handlers；
- `components/`：工作台、视图、收集流程和机会工作区；
- `components/ui/`：基础 UI 组件，不放业务逻辑；
- `db/schema.ts`：Drizzle 数据模型；
- `drizzle/`：版本化 SQL 迁移；
- `scripts/database-migrations.mjs`：启动器和 Next 运行时共用的原子迁移、旧库接管与结构校验；
- `lib/capture.ts`：网页读取、来源适配器、规则与 AI 提取；
- `lib/public-fetch.ts`：招聘抓取的地址/DNS/连接固定、逐跳校验及响应流限制；
- `lib/local-request.ts`：全部内部接口共用的 Host、来源和请求类型边界；
- `lib/action-schema.ts`：创建与更新共用的严格命令校验及日期转换；
- `lib/actions.ts`：写入协调器，统一校验、请求内容指纹、去重回执、FIFO 写锁与唯一业务事务；
- `lib/services/`：机会及阶段历史、任务、节点、材料及要求、设置及草稿的同步业务服务；共同上下文负责存在性检查与活动记录，task-plan 共用下一步任务规则；
- `lib/action-request.ts` / `lib/write-lock.ts`：请求体限额及本进程写入/恢复串行队列；
- `lib/mutation-client.ts` / `lib/workspace-reader.ts`：提交去重、确认状态和读取竞态保护；
- `lib/material-files.ts`：材料路径、实际文件与可执行内容的打开前校验；
- `lib/domain.ts`：阶段、排序、截止分桶和停滞规则；
- `lib/today.ts`：统一今日事项、焦点理由、去重风险雷达和有效统计；
- `lib/repository.ts` / `workspace-repository.ts`：同一只读事务快照、一次按机会 ID 分组与材料路径去重检查；
- `lib/workspace-pages.ts` / `components/paged-workspace.tsx`：有界活动/草稿 keyset 分页、轻量摘要及按需恢复；
- `lib/workspace-refresh.ts`：前台一分钟/聚焦/可见性刷新调度与写入门控；
- `lib/reminder-policy.ts`：上海时区转换、默认提醒及偏移校验；
- `lib/reminder-engine.ts`：可注入 SQLite/通知发送器的提醒计划、去重、重启汇总；
- `lib/reminders.ts`：macOS 通知适配器与每分钟调度；
- `scripts/`：迁移、构建、启动安装与隔离回归脚本；提醒调度在 Next 服务进程内运行，不是独立工作进程；
- `scripts/launcher-core.mjs` / `launcher-platform.mjs`：共用启动状态机与 macOS 适配器；
- `scripts/build-tools.mjs` / `build.mjs`：内容指纹、跨进程锁和完成构建回执；
- `scripts/test-sandbox.mjs` / `tests/unit/`：测试目录所有权、环境隔离和进程组清理；
- `e2e/` / `playwright.config.ts`：临时项目生产构建和真实浏览器回归入口；
- `docs/`：开发手册和使用手册。

## 3. 本地开发

要求 Node.js 22.13 或更高版本。以下命令均在实际项目目录执行。

首次安装或 lockfile 更新后使用 `npm ci` 安装锁定依赖；若此目录已有正式或开发服务，先停止它再安装，避免替换运行中的依赖。已安装且未变化的依赖不需要重复安装。

```bash
npm ci
```

开发必须从迁移开始就选择独立数据库。未设置 `ZHAOPIN_DATA_DIR` 的 `db:migrate` / `dev` 会使用当前用户的正式数据目录；换项目副本也不会自动隔离数据库。不要先对默认库迁移，再仅对 dev 指定临时目录。

以下子 shell 示例创建全新临时库，使用 3100 端口，并禁用真实通知、文件操作、钥匙串与 AI。环境设置仅在括号内生效，不影响随后正常启动正式应用：

```bash
(
  task_dev_data="$(mktemp -d "${TMPDIR:-/tmp/}zhaopin-dev.XXXXXX")" || exit 1
  echo "开发数据库目录：$task_dev_data"
  export NODE_ENV=development
  export ZHAOPIN_DATA_DIR="$task_dev_data"
  export ZHAOPIN_DISABLE_NOTIFICATIONS=1
  export ZHAOPIN_DISABLE_FILE_OPERATIONS=1
  export ZHAOPIN_DISABLE_KEYCHAIN=1
  export OPENAI_API_KEY=fake-test-key
  export OPENAI_MODEL=
  export OPENAI_BASE_URL=http://127.0.0.1:9/v1
  npm run db:migrate || exit 1
  npm run dev -- --port 3100
)
```

打开 `http://127.0.0.1:3100`；按 Ctrl+C 停止这个开发服务，临时库保留在输出的确切目录，核对无进程使用后可移入废纸篓。端口已占用时换一个空闲的 3100–3199 端口，不要停止陌生进程。示例刻意禁用系统文件选择与打开，界面会显示测试环境受限提示；实测原生动作须另行明确授权和隔离。

当前 Next.js 的开发产物位于 `.next/dev`，生产产物位于 `.next` 的生产目录，两者不是同一份构建。多个直接运行的开发/旧回归脚本仍共享 `.next/dev` 锁，不能并发启动。`npm run build` 会改写生产构建，且项目构建脚本要求先停止同目录全部 Next 服务；不要边运行正式服务边构建。日常回归优先使用第 11 节的临时项目入口，不直接复用默认库。

不要把真实 API 密钥写入 `.env`、SQLite、日志或测试夹具。界面保存的密钥通过 `lib/secrets.ts` 进入 macOS 钥匙串。

### 依赖安全维护（2026-10-03）

本轮只处理安全相关升级，不批量更新全部库。Next.js 固定到 `16.3.8`，满足 [ImageResponse 官方公告](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j) 的修复范围；当前应用未使用该 API。直接依赖 `undici@7.30.0`，AI 请求明确使用它的 `fetch`，不依赖 Node 内置客户端的版本。安装 npm 包并不会替换 Node 全局 fetch：本次环境为 Node 24.19.0，内置 undici 7.29.0，后者不在 npm 审计覆盖范围。招聘网页仍由 `lib/public-fetch.ts` 的受限 HTTP(S) 读取，不改用 Cheerio 的 fromURL。其他全局 fetch 调用仅用于本机启动健康检查和测试；后续新增公网请求应重新检查客户端与边界。

`shadcn` 是组件生成 CLI，不是已生成组件的运行需求。本项目原先只从该包导入静态 CSS，现移除 CLI 及其庞大工具链，保留实际组件依赖 `@shadcn/react`。样式原样放在 `app/shadcn-utilities.css`（源于 4.18.0，除文件头/末尾空白外内容不变），MIT 许可在 `docs/licenses/shadcn-MIT.txt`。`components.json` 保留组件元数据，但不再有本地 shadcn 命令；新增组件优先维护现有代码，确需生成器时应先独立评估其当时版本/告警，不自动重新加入项目依赖。

Drizzle Kit 固定 `0.31.11`，保留 `db:generate`。上游旧 loader 仍带入 esbuild 0.18，本项目仅对 `@esbuild-kit/core-utils` 的 esbuild 使用 `0.25.12` 定向 override（[esbuild 官方公告](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99) 修复起点为 0.25.0）。这是超出该消费方声明范围的兼容补丁，不是上游已修复；升级 loader/Drizzle 后应重新验证并评估移除，不能把 override 全局扩大。没有降级 Drizzle，也没有执行 `npm audit fix --force`。

```bash
npm ci
npm audit
npm audit --omit=dev
npm run test:deps
```

`test:deps` 先实际执行该消费方的同步 CJS / 异步 ESM 转换，再在自有临时副本中验证：现有 schema 不生成意外迁移、增加夹具后生成迁移、应用到空 SQLite、重复应用幂等。退出清理副本，绝不修改正式 schema/迁移/数据。单元测试另检查安全版本下限、CLI 未重新引入、CSS 内容指纹和许可。干净 `npm ci`、原生 SQLite 加载也已在临时副本实测。

本轮全量与 `--omit=dev` 审计均为 0 个已知告警；这是查询时锁文件对应 npm 公告的结果，不代表不存在未知漏洞或整个 macOS/Node 环境安全。依赖仍有上游弃用警告（旧 loader、whatwg-encoding），不要通过不兼容替换来掩盖。更新 lockfile 后必须跑类型/lint/单元、依赖工具及浏览器回归；重新安装依赖前应停止正式服务，之后重新构建和通过正常入口启动。

## 4. 数据模型

### Opportunity

除组织、岗位、来源、阶段和截止时间外，还包含一组驱动产品价值的决策字段：

- `decision`：`undecided | pursue | hold | skip`；
- `fitScore` / `interestScore`：用户主观评分，0 表示未判断；
- `nextAction` / `nextActionAt`：实际下一步 Task 的兼容镜像，不独立生成事项或提醒；
- `highlights` / `risks`：从原文提取并由用户核对的判断线索；
- `lastActivityAt`：停滞判断依据。

### StageHistory 与统计口径（2026-10-04）

`Opportunity.closedReason` 为 `unknown | rejected | withdrawn`。非 closed 阶段归为 unknown；decision=skip 强制 closed/withdrawn。旧 closed 记录只有明确 skip 才认定主动放弃，不猜测招聘失败。

`stage_history` 存储 id、opportunityId（级联删除）、fromStage（可空）、toStage、occurredAt（可空）、recordedAt、source（initial/transition/legacy/manual）、valid、notes；索引按机会和记录时间。创建只记录选定阶段；非待评估的建档发生时间未知。真实阶段变化追加 transition，日期为服务端变更时间，不推断前序阶段。最高记录由有效历史和大阶段顺序计算，忽略 closed，不另存可漂移的最高字段。

`addStageHistory` 接收 `{opportunityId,stage,occurredAt?,notes?}`，拒绝未来时间；补录可以早于建档，不改变当前阶段。`invalidateStageHistory` 接收 `{id,notes}`，原因必填，只置 valid=false 并追加审计活动，不删除原记录、不改变当前阶段；重复作废返回 409，原 requestId 重放返回既有回执。新增动作共用 Zod 校验、即时事务和去重回执；阶段更新、历史、活动任何一项失败整体回滚。

`lib/analytics.ts` 为不依赖数据库的纯统计函数。默认排除 decision=skip 或 closed/withdrawn，保留招聘失败及未知结束；全部卡片与阶段人数共享同一机会集合。每个阶段用有效 toStage 的机会 ID 集合去重，不使用当前 stage 的线性序号推断。投递/库内、测评∩投递/投递、面试∩投递/投递、Offer∩面试/面试分别计算转化；零分母返回 null，UI 显示“—”。环节人数不要求单调，缺史、跳环节都不得用假数据补齐。

迁移 `0005_nostalgic_arclight.sql` 只给没有历史的旧机会新增一条 legacy 当前阶段快照，occurredAt=null，recordedAt 使用原 updatedAt 表示快照依据时间，保留所有业务文本和时间戳。由第 5 节统一迁移程序执行并登记；直接 dev 初始化后启动器不会重跑已登记的数据转换。

JSON 继续兼容 version=1。新增导出 stageHistory 和 closedReason；缺历史数组的旧备份在内存中转为同样的 legacy 快照，明确的空数组则保留，不重建历史。历史 ID/枚举/日期/布尔/归属校验通过后，纳入试恢复、事务替换和逐字段回读。无效记录和作废原因活动也完整保存。CSV 仍为机会列表，不替代完整 JSON 历史备份。

UI 在 `components/stage-history-panel.tsx` 提供补录/作废二次确认、失败保留和上海时区显示；`components/analytics-view.tsx` 提供筛选及明确分母解释。测试 `lib/stage-history.test.ts` 覆盖真实环节、回退去重、统计交集、结束分类、补录/作废、幂等/回滚、旧迁移和 JSON 完整性；`scripts/check-analytics.mjs` 在独立 3118 端口验证真实浏览器、旧库直接启动、失败保留、窄屏、导出恢复及重启。

### Task、Milestone、MaterialRequirement

Task 是用户可以完成的动作，参与今日排序。Milestone 是招聘流程中的事件时间。MaterialRequirement 表示某个岗位的材料缺口，并可关联 Material 的本机文件引用。

#### 下一步任务约束（2026-10-04）

`Task.isNextAction` 表示岗位内重点；部分唯一索引 `idx_tasks_next_action` 保证每个机会最多一个。只允许选择同一机会下 todo/doing 的任务，独立任务不能作为岗位下一步。`setNextTask` 接收 `{opportunityId,taskId}`，传 null 取消指定但不删除任务。创建/修改机会的计划字段会创建、复用或更新真实任务，事务内同步镜像；同名且日期兼容的待办可复用，不覆盖日期不同的独立任务。完成/跳过焦点任务清除重点和镜像；恢复不自动指定。

今日 planner 和时间线仅遍历任务一次，下一步使用真实任务 ID；通知统一使用 `task:taskId:scheduledFor`。取消重点不代表取消待办或提醒。Offer 后的真实下一步任务也继续参与，只有投递截止退出。外部写入不得只改机会镜像列，否则违反这个约束。

迁移 `0004_workable_pepper_potts.sql` 添加重点字段/唯一索引，一次性将旧非空计划转换为真实任务，优先复用同名/日期兼容的未完成任务。保留其他任务、正文、活动和时间戳，不伪造推进记录。应用与启动脚本共用第 5 节程序，已登记转换不再重跑；未登记的旧运行时结构在限定兼容范围内接管。历史 `nextAction` 提醒记录保留，并复制对应 task 去重记录，避免换实体 ID 后重复通知。

JSON 仍支持版本 1：旧备份缺少重点字段时默认 false，在内存中转换后才试恢复；新备份先校验重点归属、状态、唯一性和镜像一致性，损坏数据不得用转换掩盖。备份恢复保留原任务/普通文本/时间戳，新增任务与映射送达记录随后参加逐字段回读核对。不要依赖随机生成 ID 来断言旧备份转换结果，应检验关系与内容。

#### 材料维护约束（2026-10-04）

材料编辑与删除仍经共用 action 校验、事务及请求回执。`deleteMaterial` 只删除数据库引用，关联要求保留、materialId=null、completed=false，并按岗位写活动；不得调用文件删除。`updateMaterial` 仅在路径或版本实际变化时将关联要求恢复待准备；修改名称/类型/备注不影响完成。保存新路径不意味着文件安全，打开时仍由 `material-files` 逐次校验。

`createRequirement` 接收 `{opportunityId,name,notes?,materialId?}`，存在性验证后创建未完成要求；`updateRequirement` 支持名称、说明、关联及状态，替换/取消关联时强制 completed=false，必须另一次确认就绪。`deleteRequirement` 只移除当前岗位要求及追加活动，不删除共享材料。全部关联更新与活动在同一事务，任何一步失败整体回滚。

`MaterialDialog` 按材料 ID/新建会话挂载，取消不会保存/串用草稿，选择器取消保留路径；材料库删除使用影响说明及确认。`RequirementEditor` 支持局部编辑、可见错误与二次删除确认；要求列表显示版本及文件缺失，不把路径存在当作内容审查。

任务、节点和材料状态发生变化时，写接口必须同步更新 Opportunity 的 `lastActivityAt`，并在 Activity 中留下人类可读记录。否则首页会把刚推进的机会错误标记为停滞。

### Activity、ExtractionDraft、ReminderDelivery

Activity 保留推进历史。ExtractionDraft 保存尚未确认的提取结果及证据。ReminderDelivery 用唯一 delivery key 抑制重复通知。

## 5. 迁移策略

修改 `db/schema.ts` 后执行：

```bash
npm run db:generate
```

检查新生成的 `drizzle/*.sql`，确认迁移不会删除用户数据。业务建表、索引和字段升级的执行来源只有这些 SQL 文件；`db/schema.ts` 保留为 Drizzle 类型模型与迁移生成输入。`lib/db.ts` 不再维护另一套 CREATE/ALTER 或按字段存在与否执行特定升级的分支。

#### 统一执行与记录（2026-10-04）

`scripts/migrate.mjs` 和 `lib/db.ts` 都调用 `scripts/database-migrations.mjs` 的 `migrateDatabase(connection,{directory})`。启动器使用项目绝对迁移路径，Next 使用启动工作目录下的 `drizzle/`；部署必须保留完整目录。新开发字段只修改 schema、生成/审查新 SQL，不再增加运行时 DDL。

执行器先加载、校验完整的历史迁移文件，在空内存库执行同一批 SQL 取得目标结构；实际连接先设置 10 秒 busy timeout、外键 ON 和 WAL。随后在 SQLite immediate 事务内重新读取迁移记录，校验文件 SHA-256，执行全部待应用迁移、登记成功记录并核对完整结构/关联，整批成功才提交。多个进程依靠 SQLite 写锁串行化，后来者在锁内看到最新记录，不重复执行；不得嵌套进业务事务。WAL/连接配置不属于业务事务，失败承诺是业务结构、数据及迁移记录整批不提交，不是数据库文件字节不变。

`__zhaopin_migrations` 为私有元数据，保存 name、applied_at、checksum，不进入 JSON 业务备份。旧记录首次接管先添加 checksum 列，在结构校验通过后补齐校验值，保留原应用时间；失败时连元数据变更一并回滚。无法追溯旧记录创建时的文件字节，首次校验只是建立现有文件的基线；SHA-256 用于发现此后意外修改，不是防恶意用户的签名或认证。已应用文件不可再格式化、重写或删除，修正必须另建迁移。数据库包含当前程序未知的迁移时拒绝降级。

兼容只限原 0000–0005 的确切文件名：接管旧运行时已创建的表/列/索引后仍必须通过目标结构核对，不再仅因 opportunities 存在而跳过整个 baseline。旧无校验值记录可能缺少命名的提醒唯一索引（原运行时使用 inline UNIQUE），只在首次接管时从原 SQL 补齐缺失命名索引，不重建表或重复数据转换。未来新迁移不静默跳过同名列，以免掩盖错误或遗漏的数据转换。

结构校验包括列类型、默认值、主键、非空约束、外键、显式及自动唯一索引、索引列顺序/方向/排序规则、部分索引条件和孤立关联。已知旧运行时曾省略主键显式 NOT NULL，允许保留这些表但要求现有主键不为空；不自动重建或清理数据。已有带校验值记录的结构漂移、错误列/索引、孤立关联、未知版本或坏 SQL 均明确失败，不能通过删库、清空迁移表或伪造记录“修复”。

`lib/database-migrations.test.ts` 使用自有临时目录、内存/磁盘 SQLite 和真实多进程测试，覆盖旧运行时/旧记录接管、部分基础结构、一次性任务/历史转换、结构异常、登记失败/转换失败整批回滚、重试、文件校验、未来迁移、六进程并发初始化和重启持久化。业务回归仍走统一 `npm run test:e2e`，不要用正式库测试恢复或坏迁移。

严禁用删除数据库或 `DROP TABLE` 代替迁移。

### 生产启动与更新（第 9 项修复）

`start.command` 和已安装 `.app` 都调用 `scripts/launcher.mjs`，没有 `/api/state` 快捷返回分支。普通启动会检查更新；`./start.command --restart` 明确重启未变化版本，`stop.command` 使用相同锁和服务身份检查。`.app` 是浏览器启动入口，不是独立 WebView；失败用 AppleScript 显示中文原因及“查看日志”。安装器按当前项目路径更新生成文件，不递归清空既有应用包。

`sourceFingerprint()` 按排序后的相对路径和文件内容计算 SHA-256，覆盖应用、组件、lib、db、drizzle（包括删除文件）、hooks、public、scripts、package/lock、Next/TS/PostCSS 配置和三个运行脚本，再加入 Node 版本/ABI/平台。不依赖 mtime；不读取用户库、材料或钥匙串。运行环境变量改变不视作源码更新，应显式重启。生产构建只在成功且输入前后指纹一致后，原子写入 `.next/zhaopin-build.json`，同时绑定 Next BUILD_ID；失败会移除旧成功回执，不启动不完整版本。

`GET /api/health` 返回应用 ID、匿名安装身份（真实项目根和数据目录的摘要）、运行指纹、BUILD_ID、模式和 PID；不读 SQLite，禁止缓存，仍执行 Host/来源校验。`server.mjs` 从完成回执向子进程注入固定版本，旧服务不会因为磁盘被修改而报告新版本。健康身份不是认证；启动器还检查真正监听 PID 与受管理 launchd 作业的父子关系、精确 run-server 路径及工作目录。只有版本匹配且 `/api/state` 可读才复用。陌生端口、其他项目、未管理的旧版/开发服务不会被自动终止；管理员需先手动停止它们。

项目目录和数据目录各有 `.zhaopin-launch.lock`，同时串行化启动、停止、迁移和构建。记录 owner PID、token 和构建/迁移子进程；只有所有记录进程都已退出才回收陈旧锁，释放只删除自身 token。活动/损坏锁不盲目删除，等待超时给出路径。更新流程为：核实身份 → 停止旧服务并确认端口释放 → 检查同项目其他 Next 服务 → 迁移 → 必要时构建 → 注册 launchd → 验证准确版本与数据可读 → 打开浏览器。`npm run build` 也使用项目锁，并拒绝在同项目 Next 服务运行时覆盖 `.next`。直接绕过脚本执行 Next CLI 不受此锁保护。

登录 LaunchAgent 运行最后一次成功构建，不在服务进程内重复迁移/构建；源码更新后打开入口执行完整检查。构建失败保留数据库，但不会自动回退被重建的 `.next`；修正问题后重试。若更新途中源文件继续变化，启动器拒绝将它标记为最新版。

真实 macOS 回归（先生成成功生产包）：

```bash
task_launcher_dir=$(mktemp -d /tmp/zhaopin-launcher-native.XXXXXX)
ZHAOPIN_TEST_DATA_DIR="$task_launcher_dir" node scripts/check-launcher.mjs
```

脚本只接受全新 `zhaopin-` 临时目录及 3100–3199 端口（默认 3116）。将项目/依赖/构建克隆到临时目录，使用独立测试 launchd label、安装目录、数据库，禁用真实通知/文件操作/AI/浏览器打开/失败弹窗和 LaunchServices 注册。覆盖真实并发启动、保留旧 mtime 的内容更新、生成 `.app` 更新、安装式 LaunchAgent 重启、真实编译失败与修正恢复、陌生 state 200 服务和停止。最终退出自身服务，保留证据目录。测试用例另验证锁/事务步骤、活动子进程保护和失败对话框 argv；在 macOS 用 osacompile 检查对话框脚本语法，不自动弹出真实警告。

## 6. 招聘页面采集

`fetchJobText()` 先规范化并校验 URL，再按以下顺序处理：

1. 已知来源适配器；
2. 通用服务端 HTML 正文提取；
3. 返回结构化兜底提示，要求用户粘贴正文。

腾讯招聘岗位详情是客户端动态页面。`fetchTencentJob()` 从 URL 读取 `postId`，访问同源官方 `ByPostId` 接口，并把职责、要求、地点、业务和特别说明组装为稳定文本。不要再依赖岗位详情 HTML 中的空 `#app` 容器。

所有招聘网页和来源适配器必须共用 `lib/public-fetch.ts` 的 `fetchPublicPage()`，不能直接调用 `fetch()` 或其他自动跟随跳转的客户端：

- URL 只允许 HTTP/80 或 HTTPS/443，无用户名/密码；用标准 URL 解析器先规范化编码 IPv4、IPv6 方括号和默认端口。阻止回环、私网、链路本地、共享地址、组播、保留/文档/隧道地址及本机域名。IPv6 采用保守的普通全球单播地址策略；映射 IPv4、NAT64 及特殊用途前缀不作为招聘目的地址。
- 每次连接前使用 `dns.lookup(..., { all: true, order: 'verbatim' })` 检查全部记录；只要包含不允许的地址就拒绝。选取已验证公网 IP，通过 Node HTTP(S) 自定义 `lookup` 固定实际连接，不进行第二次 DNS 解析；`agent: false` 和关闭地址自动选择避免复用其他连接或未验证目标。优先 IPv4，只有 IPv6 时也支持连接。
- 保留原域名用于 Host、TLS SNI 和证书验证，明确启用证书校验；不携带 Cookie、Authorization 或登录凭据。抓取不使用环境代理，不设置绕过策略或“允许私网”的环境开关。
- 手动处理 301/302/303/307/308。每跳重新验证 URL、DNS 和实际连接目标，关闭上一个跳转响应；最多 5 次，检测循环，禁止 HTTPS 降级 HTTP。相对跳转和 HTTP 升级 HTTPS 可用。
- DNS、连接、全部跳转和响应正文共用 12 秒网络时限。响应头限制 16 KiB；下载字节和 gzip/deflate/Brotli 解压后字节分别流式限制为 2 MiB。超限立即销毁流，在 Cheerio/JSON 解析前停止。HTML/XHTML 与 JSON/+json 按适配器类型检查。
- `PublicFetchError` 提供稳定错误码及中文提示；capture 路由以 HTTP 422 / `needsText: true` 返回手动兜底，不创建草稿。用户同时提供正文时不读取该来源链接，链接仍可作为来源保留。AI 接口地址属于用户主动配置的独立通道，本轮没有改变其行为。

地址范围与连接接口依据 [IANA IPv4 特殊用途注册表](https://www.iana.org/assignments/iana-ipv4-special-registry/)、[IANA IPv6 特殊用途注册表](https://www.iana.org/assignments/iana-ipv6-special-registry/)及 [Node HTTP request 文档](https://nodejs.org/api/http.html#httprequestoptions-callback)。安全策略有意比“Globally Reachable”列更保守，不将特殊协议、隧道或转换地址当作普通招聘站点；地址分配变化时须人工核对并增加边界测试。

新增来源适配器时：

- 只调用公开且与用户 URL 直接对应的读取接口；
- 必须经 `fetchPublicPage()`，复用 DNS 固定、逐跳校验、总超时和响应体限制；不得另建无约束的读取路径；
- 不绕过登录、验证码或访问控制；
- 返回 `FetchResult`，包含 `text`、`sourceName` 和 adapter id；
- 失败时不得把底层英文异常直接展示给用户；
- 必须保留粘贴正文兜底。

提取层分为规则模式和可选 AI 模式。AI 输出只是草稿，不能直接创建 Opportunity，也不能代替用户填写匹配度和兴趣度。AI 的“今天”复用上海时间转换函数生成，不使用 UTC 日期截取或宿主时区；凌晨、跨年和闰日由固定时间请求断言覆盖。

规则兜底的截止日期也复用 `extractionSchema.shape.deadline` 校验与规范化：只有日期按上海当天 23:59，有时分按上海时间，非法日历或时分留空。省略年份先取当前上海年份；若有效日期已早于当前时间超过 30 天，沿用原规则尝试下一年并重新校验，不能把非闰年 2 月 29 日滚成 3 月。该年份推测不是招聘方事实，仍须用户确认。`capture.test.ts` 和 `capture-ai.test.ts` 可在 `TZ=America/New_York` 下运行，核对宿主时区不改变上述结果。

AI 通道会向用户配置的服务商发送招聘正文，可能产生费用；“本地应用”只表示本机存储和服务，并非所有提取都离线。材料库文件不自动上传，但用户粘贴到正文的任何内容都进入提取输入。配置地址为基础 URL，服务追加 `/chat/completions`；密钥输入留空表示保留，不是删除。配置保存不进行连通性探测，实际提取失败回退规则。无界面模型配置时仍会回退 `OPENAI_MODEL`，不得把清空界面模型名描述为任何环境下都能禁用 AI。

### AI 草稿校验与证据边界

`lib/extraction.ts` 是运行时 schema 和前后端 `Extraction` 类型的唯一来源。先校验 AI 响应信封，再校验模型字段，最后与规则默认值合并并校验完整草稿；不再将未知 JSON 强制断言为 TypeScript 类型。

- AI 响应流（含解压后的正文）最多 256 KiB；content 最多 64,000 字符。单次提取包含兼容重试在内共用 30 秒超时。非文本 content、无效 JSON、非法数组/枚举/数值、过长字段均回退规则，不将坏数据保存为 AI 草稿。
- 短字段最多 300 字符，正文 8,000，注意事项 4,000；标签和材料各最多 20 项，亮点/风险各 4 项，任务最多 4 项且预计耗时为 0–1,440 的整数。显式 null 数组不视为“缺省”，明确空数组不被默认任务覆盖；遗漏字段可用规则补齐。主观决定/分数、来源链接和任务来源由服务控制，未知字段（如 stage）剥离。
- 日期必须是真实日历日期；`YYYY-MM-DD` 固定解释为 Asia/Shanghai 当天 23:59，带时间的 ISO 必须包含时区并转成 UTC。不存在的日期、无时区时间或溢出时分秒拒绝；null、跨年、闰年及已过期日期可用。
- evidence 最多 60 项，每个短句最多 600 字符。仅保留固定字段或有效数组索引、且忽略空白后可以在来源正文中定位的短句；无依据项移除并提示。索引形式为 `tasks[0].title`、`tasks[0].dueAt`、`requirements[0].name`、`highlights[0]`、`risks[0]`。AI 未提供 evidence 时不借用可能已失配的规则证据。
- 证据匹配只证明短句存在，不证明字段推断或日期关联正确。页面显示“提取时原文”和缺失依据提示；编辑后仍需人工核对。confidence 只作为模型自评显示，不当作系统准确率；遗漏自评显示未提供。建议任务与招聘方硬性要求明确区分。日志不输出模型响应、原文、密钥或验证值。

单元检查（不调用真实 AI，`capture-ai.test.ts` 也模拟数据库与钥匙串）：

```bash
npx vitest run lib/extraction.test.ts lib/capture-ai.test.ts
```

真实 Route Handler/Chrome 回归使用脚本自建的本机模拟 AI 和独立 Next 服务，不调用真实模型或钥匙串。必须指定全新临时目录；脚本拒绝已有数据库及正式端口，自动停止自己的服务、清理测试机会并标记丢弃草稿，保留临时库与截图供检查。验收后手动清理该确切目录。

```bash
task_ai_data="$(mktemp -d /tmp/zhaopin-ai-check.XXXXXX)"
ZHAOPIN_TEST_DATA_DIR="$task_ai_data" node scripts/check-ai-extraction.mjs
```

默认独立端口 3110，可用 `ZHAOPIN_TEST_PORT` 指定 3100–3199。测试生产包时使用另一个全新目录，并设置 `ZHAOPIN_TEST_SERVER_MODE=start`；先停止共享 `.next` 的正式服务再构建，构建时指定临时 `ZHAOPIN_DATA_DIR` 和禁用通知。浏览器优先使用系统 Chrome，否则需 Playwright Chromium。脚本覆盖坏数组/null/时间/长度/JSON、证据移除、取消、纠正保存及刷新持久化，记录桌面与窄屏截图。

安全单元检查使用模拟 DNS、HTTP 流和连接选项，不实际访问私网，也不初始化数据库：

```bash
npx vitest run lib/public-fetch.test.ts
```

`scripts/check-capture-safety.mjs` 验证真实 API/Chrome 的安全拦截及正文兜底，并只向公开 `example.com` 与腾讯岗位接口发出读取请求。需独立端口及未配置 AI 的临时库（同时将测试服务的 `OPENAI_MODEL` 设为空）；脚本会创建并标记丢弃测试草稿，不保存正式机会。结束后停止测试服务并删除该临时目录。示例：

```bash
task_data="$(mktemp -d /tmp/zhaopin-capture-check.XXXXXX)"
echo "$task_data"
ZHAOPIN_DATA_DIR="$task_data" ZHAOPIN_DISABLE_NOTIFICATIONS=1 \
  ZHAOPIN_DISABLE_FILE_OPERATIONS=1 ZHAOPIN_DISABLE_KEYCHAIN=1 \
  OPENAI_API_KEY=fake-test-key OPENAI_MODEL= OPENAI_BASE_URL=http://127.0.0.1:9/v1 \
  node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3109
```

另一终端中，将路径换成上述实际输出：

```bash
ZHAOPIN_TEST_DATA_DIR=/tmp/zhaopin-capture-check.实际随机后缀 \
  node scripts/check-capture-safety.mjs
```

该真实公网检查可能因网络或岗位下线失败，不能代替可重复的安全单元检查；不需要配置或消耗 AI 接口额度。

## 7. 内部接口

第一版没有公开 API。浏览器只调用本机 Route Handlers：

- `GET /api/state`：返回聚合工作区状态；
- `GET /api/state?section=activities&opportunityId=…&cursor=…`：岗位活动按需分页；`section=drafts` 返回待确认草稿摘要分页，`section=draft&id=…` 读取单个待确认草稿；
- `GET /api/health`：不读 SQLite 的运行身份与构建版本，仍经同一来源边界；
- `POST /api/action`：按 action 名称执行数据写操作；
- `POST /api/capture`：读取来源并创建 ExtractionDraft；
- `POST /api/files`：`{action:"pick"}` 选择材料；`{action:"open",materialId}` 打开已登记材料，不能直接传路径；
- `GET /api/reminders` / `POST /api/reminders`：读取提醒状态 / 手动测试通知；
- `GET /api/export`：JSON 或 CSV 导出；
- `POST /api/import`：完整 JSON 恢复。

所有写入必须经 Zod 校验。错误响应应是用户可执行的中文说明，服务端细节只写日志。

### 状态快照、分页与刷新（2026-10-04）

`readWorkspaceState(db, now, fileExists)` 可注入数据库、固定时间及文件检查器。使用同步 deferred 只读事务一次取得机会、任务、节点、材料、要求、设置、阶段历史和 pending 草稿数量，避免跨进程写入期间混用新旧数据；文件检查与分组在事务外完成。关联数组各建一个 Map，保持查询的组内顺序，不再逐机会遍历全表；任务仍使用共用 comparator，材料相同路径每次状态读取仅检查一次，不做永久缓存。

常规响应的 `activities` 与 `drafts` 兼容字段为空数组，表示未加载，不表示数据库记录已删除；待确认数量由 `pendingDraftCount` 给出。活动内容、草稿来源正文和提取结果不再随每分钟状态刷新传输。机会、任务、要求、节点及阶段历史仍全量读取，后者供真实漏斗计算，未在本项实现所有数据的分页或声称可无限扩展。完整 JSON 导出/恢复不受展示分页影响。

活动与草稿每页固定 20 条、查询 21 条探测下一页，按 createdAt DESC / id DESC 排序。游标含列表类型、机会归属、毫秒时间及 ID，严格校验后绑定 SQL 参数；拒绝跨归属/跨列表、超长/坏游标、重复及未知查询参数。游标不是权限凭证，全部读取仍先执行 guardLocalRequest，成功/失败均 no-store。采用 keyset 而非 offset，同时间、删游标行及新增头部不会导致翻页位移；新头部须刷新查看。摘要只读公司/岗位与创建时间，不返回原文/提取体；单草稿必须仍 pending，结构失效保留原文，不编造恢复字段。

详情只在“节点与记录”挂载分页读取，草稿列表只在展开时读取。分页失败保持原已加载项，重试沿用失败页；取消、换归属或卸载时中止旧请求并失效化序号，迟到响应不能覆盖新会话。岗位 updatedAt 或待确认数量改变时回读首屏，手动“刷新记录”也重置到最新首屏；已经加载的更早页不会随每次常规状态读取重置。

`startWorkspaceRefresh` 每 60 秒仅在 visible 且写入/恢复不忙时尝试读取，并监听 focus/visibilitychange，1 秒内重复事件合并，允许系统时钟回拨后恢复，卸载时清理所有监听/定时器。`workspace-reader` 后台读取合并正在进行的读取，不能废弃显式/保存后读取；显式读可中止旧读，写入及恢复开始失效化旧响应，超时 15 秒。MutationClient 的 `isBusy` 覆盖保存与已提交但尚需显式刷新的状态，自动刷新不自动解除 REFRESH_REQUIRED。恢复流程也报告忙状态，避免轮询抢读。表单状态不随后台数据覆盖；机会及其他实体的字段级并发保护见下文。

验证入口：`workspace-repository.test.ts`（两万关联一次归属读取、活动/草稿正文不进入周期性响应、Shanghai 跨日与五天停滞、真实 WAL 双连接快照）、`workspace-pages.test.ts`（同时间多页/删游标/摘要/格式错误）、`workspace-refresh.test.ts`（隐藏/聚焦/暂停/回拨/取消/异常）、`state-route.test.ts`（统一本机边界和错误）。`scripts/check-state-refresh.mjs` 使用全新临时库、独立 3119 端口、真实 Chrome 与可控浏览器时钟，验证分页、草稿确认/移除、窄屏、自动刷新、编辑保持及读取失败重试，不发送真实通知/AI/钥匙串/文件动作。

### 机会字段级并发保护（2026-10-04）

`lib/opportunity-edit.ts` 是纯共享逻辑，无数据库、Node 或网络依赖。`buildOpportunityUpdate(original, draft)` 按固定可编辑字段白名单生成实际 diff，排除 id、时间戳和展示/关联属性，无修改返回 null。提交格式为 `updateOpportunity` 的 `{id, ...changes, expected:{字段:编辑前值}}`。Date / ISO 经 JSON 序列化按同一瞬间比较，数组按内容和顺序比较；不依赖毫秒 updatedAt，避免时间碰撞和不相关活动误报。

expected 与普通字段共用严格 Zod 类型、大小、日期、枚举校验。提供 expected 时必须覆盖所有变更字段，阶段/结束原因/投入决策以及下一步标题/时间必须完整覆盖对应关联组，未知字段、缺基线和仅基线请求拒绝。为旧内部脚本及客户端兼容，未提供 expected 的调用仍可执行，但不具有并发保护；这不是新的认证机制或公开 API。不得将“所有写入已受保护”作为保证。

机会服务在原 immediate 写事务内读取并比较最新持久字段，出现差异抛出 409 / EDIT_CONFLICT，返回字段名而不泄露原文；尚未产生任何任务/阶段历史/活动/回执写入。不存在记录仍返回 404。expected 从持久化 changes 中剥离。持久化去重回执优先于比较：已成功写入的同请求重放即使基线过时也返回原成功结果，不会重复写入。阶段和下一步的原业务事务规则不变，不新增迁移或备份字段。

界面完整编辑在点击“编辑”时捕获 original，备注/复盘在首次输入时捕获独立 original；后续轮询不替换原值。新版机会保存及快捷决策均用 diff。MutationClient 收到明确 EDIT_CONFLICT 后只刷新供核对，不重发写请求，不自动 rebase，不解除已提交待刷新的其他保护。草稿仍由组件持有，展示已保存冲突字段；只有用户明确确认“放弃编辑并载入最新”才重建基线。刷新失败仍保留草稿并显示已有重试读取提示。未保存草稿不写本地存储，关闭/刷新仍会丢失。其他实体、设置和删除保护见下节。

验证：`lib/opportunity-edit.test.ts` 覆盖同字段并发胜者、不同字段合并、相同时间戳、日期/数组、关联阶段、完成任务后旧计划、无关活动、缺失基线、旧内部兼容、回执跨服务重放和冲突整库不变；MutationClient 测试覆盖冲突刷新成功/失败均不重发、不改变基线。`scripts/check-edit-conflicts.mjs` 在全新隔离库及 3116 端口开两个真实 Chrome 窗口，验证冲突后输入保留、轮询不绕过、明确放弃取消/确认、重新保存、不同字段不重传、备注独立基线和窄屏。

### 关联记录、设置及删除并发保护（2026-10-04）

`lib/record-edit.ts` 的纯函数 `buildRecordUpdate` 按 task / milestone / material / requirement 的白名单生成实际 diff 与 expected，排除展示字段、关联数组、时间戳及删除令牌，无修改返回 null。`guardedUpdate` 在严格部分字段 schema 上先扩展 id / expected，再校验变更字段及关联组完整性。任务 title / dueAt / status、节点 title / scheduledAt / status、材料 filePath / version、要求 materialId / completed 必须完整核对对应组。expected 仍为兼容旧内部调用而可选；新版 UI 必须提供，缺少它的旧客户端不获得保护。

各实体服务在同一个 immediate 事务内用 `services/edit-guard.ts` 检查持久行，剥离保护字段后再写入关联数据、活动与回执，冲突返回 409 / EDIT_CONFLICT。去重回执优先返回原结果，不能因基线过时重复执行已成功动作。任务完成、跳过、恢复和节点快捷完成也通过 diff；TaskEditor 捕获编辑起始值，可修改名称、上海时间与预计耗时，修改重点任务仍同步机会镜像。材料弹窗将当前材料另传为 latestMaterial，仅供显示冲突，不能用它偷偷替换编辑基线。要求关联下拉在首次更改时保留原记录，明确放弃才清空。

`buildRequirementUpdate` 对带材料关联的“就绪”提交附加 expectedMaterial `{id,filePath,version}`；schema 校验 id 与要求基线关联一致，服务在同一写事务检查材料是否已被替换。仅改材料备注不阻断就绪；改变路径 / 版本仍重置全部关联要求。此检查不验证文件内容，原路径覆盖且不更新版本不可被发现。无电子关联的线下材料仍可人工标记。`setNextTask` 附带原 expectedTaskId 与目标任务的 title / dueAt / status：选择对象或原重点变化时拒绝，不会取消别人刚选的新重点。

`lib/settings-edit.ts` 仅提交真正修改的 baseUrl / model / staleDays 与可选 apiKey；更改接口、模型或密钥须同时核对 baseUrl / model / keyRevision。既有 settings 表新增的是按需写入的 `aiKeyRevision` 元数据，不是迁移字段，也不是密钥。协调器先在进程写锁内、调用钥匙串前预检；数据库服务在 immediate 事务内再检，防止原生命令等待期间跨连接变更。密钥成功提交数据库后产生新的非秘密版本标记，回执只返回 saved / keyRevision，不保存配置正文或密钥。

钥匙串与 SQLite 仍非原子跨存储事务。预检冲突不调用钥匙串；钥匙串失败时数据库不变；密钥已写但第二次核对或提交失败，返回 SETTINGS_PARTIAL，不能声称密钥已回滚。UI 保留输入供人工核对；“载入最新设置”须确认放弃未保存配置及密钥输入。无 expected 的旧设置调用保留原默认值规则；新版部分更新不为省略字段补默认值。未保存过接口地址时输入保持空，默认 OpenAI 地址仅作占位提示，读取端仍保留原回退规则；不能通过 UI 预填制造变更，使只改 staleDays 也意外修改接口。备份可包含非秘密 keyRevision，但不包含钥匙串密钥。

删除机会、材料、要求的新版客户端提交 expectedVersion。`lib/delete-version.ts` 将日期规范化、对象键排序后生成 SHA-256 令牌：机会涵盖持久行、任务、节点、要求、阶段历史及活动数量；材料涵盖持久行及关联要求；要求涵盖自身持久行。关联行按 id 排序。状态读事务同时读取活动数量，不传输活动正文；服务在原写事务重算，变化则拒绝删除且不产生级联修改。删除窗口保留打开时令牌，不随后台读取替换，必须关闭并重新核对。令牌只用于过期确认检测，不是权限凭证或完整数据库防篡改证明；不校验活动正文、文件内容等外部状态。旧调用可省略令牌，因此刷新旧页面仍是升级要求。令牌只存在 DTO，未写数据库或 JSON 备份；无需新迁移。关联分组仍使用 Map，令牌的相关行排序另有 O(k log k) 成本，不声称全量快照无限扩展。

`lib/record-edit.test.ts`、`lib/settings-edit.test.ts`、`lib/delete-version.test.ts` 新增 76 个测试，覆盖字段合并 / 同字段拒绝、关联组、材料替换竞争、旧重点取消、设置预检与原生命令期间变更、部分成功、回执优先 / 回滚以及删除前关联变更。扩展的 `scripts/check-edit-conflicts.mjs` 在真实双 Chrome 会话验证输入保留、任务编辑与下一步同步、节点 / 材料 / 要求冲突、拦住材料就绪请求后替换版本、旧重点取消、设置独立字段保存，以及三类过期删除确认。所有夹具只写隔离库。

### 保存协议与事务（第 8 项修复）

#### 业务服务边界（2026-10-04）

`createActionService(client, saveApiKey)` 保持原调用协议，路由仍只负责本机请求保护、受限读取和错误映射。`actions.ts` 只协调校验、内容摘要、同请求合并、持久化回执、写锁、钥匙串与 SQLite 提交；`services/dispatch.ts` 使用判别联合穷尽分派，新增 action 后遗漏分派或实体实现会被 TypeScript 的 never 检查拒绝。

实体归属：`opportunities.ts` 管机会和阶段历史，`tasks.ts` 管任务和焦点选择，`milestones.ts` 管招聘节点，`materials.ts` 管共享材料及岗位要求，`workspace.ts` 管活动、草稿取消与数据库设置。`context.ts` 注入同一个事务 writer、时间和活动函数；`task-plan.ts` 让机会计划编辑与任务维护共用焦点规则。错误类在 `services/errors.ts` 定义，由 `actions.ts` 原样再导出，路由的 instanceof、状态码及错误代码不变。

这些模块是内部实现，不是新的对外入口。只能从协调器执行已通过 schema 的命令；实体服务不得导入全局 `lib/db`、自行打开连接/事务、写回执、执行网络或原生命令，也不得成为 async。一次动作涉及多实体时全部使用传入 writer 和 timestamp，回执最后写入同一个 immediate 事务；调用钥匙串仍在协调器的事务外、进程写锁内。修改服务时必须验证关联写入和活动/回执失败均整体回滚，不能为拆文件把原子操作拆成独立提交。

`lib/action-services.test.ts` 覆盖全部 19 种命令的回执保存失败、全表回滚、同 ID 失败后重试、重建协调器后的持久化重放及错误类身份；使用内存库、真实 migration SQL 和模拟钥匙串。它补充而不替代既有动作、下一步/材料、阶段历史测试与真实浏览器回归。此次仅改变实现结构，不改变输入协议、数据库结构、交互或统计口径。

`/api/action` 使用严格判别 schema，拒绝未知字段、空更新、空名称、非法枚举/评分/耗时和不存在的关联记录。创建与部分更新共用字段规则；更新省略的字段保持原值。时间只接受带时区的真实 ISO 时间、有效毫秒时间戳或显式空值；`null`/空字符串表示清空，不能用宿主时区猜测缺少时区的字符串。请求体流和 Content-Length 均限制为 2 MiB，超限返回 413；输入错误为 400，记录不存在为 404，重复机会/请求冲突为 409。

机会、任务、节点、材料要求的写入与父机会活跃时间、活动记录及成功回执在同一个同步 SQLite immediate 事务内提交。失败全部回滚；事务内不等待网络或原生命令。放弃决策强制进入终态。`mutation_receipts` 由统一迁移程序执行 `0003_mutation_receipts.sql` 建立，不再另有运行时建表。

浏览器提交携带 UUID `requestId`，命令行兼容不携带 ID 的旧调用；不带 ID 的创建没有重试去重保证。同 ID、同规范化内容返回原成功回执，内容不同返回冲突；成功回执持久化后，即使服务重启也不会重复执行该 ID。库中只保存内容指纹及简短结果，不保存提交正文或密钥。回执不自动过期、不进入 JSON 备份；恢复备份会在同一事务将既有回执标记失效，旧请求重试返回明确冲突，不能重新执行到恢复后的数据上。恢复前 SQLite 快照包含这些内部记录。

客户端同步提交锁防双击；网络异常、5xx 或缺少有效成功回执时保留同一内容的重试 ID。此 ID 仅在当前窗口内存中保留，修改输入、刷新页面或新开窗口不能沿用，因此结果未知时必须先核对记录，不可承诺任意重复提交都能去重。收到成功回执后，即使读取列表失败也按“已保存、刷新失败”处理，禁止再次写入，直到手动刷新成功；旧的并发读取不能覆盖新状态。

设置写入和备份恢复共用本进程 FIFO 写锁。钥匙串写入超时 15 秒，先于设置数据库事务；钥匙串与 SQLite 不是分布式事务：钥匙串失败时数据库不变，密钥已写但数据库失败时返回明确部分成功说明，不谎报整体回滚。写锁不能替代跨进程的原生命令协调。日志只输出存储错误代码，不输出输入、密钥或原生命令参数。

可重复的生产 API/Chrome 验收：

```bash
task_mutation_dir=$(mktemp -d /tmp/zhaopin-mutation-browser.XXXXXX)
ZHAOPIN_TEST_DATA_DIR="$task_mutation_dir" node scripts/check-mutations.mjs
```

先在隔离数据目录构建生产包，构建时停止所有共享 `.next` 的服务。脚本使用独立 3115 端口和全新临时库，自动停止自身服务；禁用真实通知、文件操作和 AI。覆盖双击、写入后丢响应再重试、写入成功但刷新失败、非法输入、删除后的旧界面、材料关联失败、设置及事务回滚，生成桌面/窄屏截图。直接运行脚本时测试目录不自动删除，可复查或移动到废纸篓。第 11 节的统一 Playwright 入口会自动隔离并清理；默认单元测试也已自动隔离。

### 本机来源边界（第 7 项修复）

全部内部 Route Handler（含新增 health）的每个 GET/POST 入口首先调用 `guardLocalRequest()`，拒绝后不读请求正文、不执行对应业务或原生命令。新增接口也必须接入，不能仅依赖 CORS 或回环监听：

- 只接受 HTTP、明确的 `127.0.0.1` 或 `localhost` Host，端口必须与服务内部 URL 一致。Next 内部将 hostname 归一为 localhost 时，仍以受限的传入 Host 匹配浏览器来源。拒绝任意域名、别名、其他端口；不使用 Forwarded/X-Forwarded-* 授权。
- 有 Origin 时必须完整匹配本次请求的源；没有 Origin 但有 Referer 时核对其源。两个本机端口、localhost 与 127.0.0.1 在浏览器来源匹配中均不能互换。拒绝 `null` 来源；有 Fetch Metadata 时只允许 same-origin 或直接导航的 none，拒绝 same-site/cross-site、no-cors 及嵌入目标；无来源的 none 写入也拒绝。
- 写入只接受准确的 `application/json` 媒体类型，可带 charset；拒绝 text/plain、表单和 application/jsonp 等前缀伪装。边界失败统一 HTTP 403、`LOCAL_REQUEST_BLOCKED`，不开放跨来源响应头。自动 OPTIONS 不执行业务，也不开放 CORS。
- **命令行例外是明确的信任选择**：来源及 Fetch Site 头都缺失的本机 CLI 可读取/备份，写入仍须 JSON。这不是认证机制，本机程序可伪造头；该策略不能保护已经被本机恶意程序控制的用户会话。不要公开监听地址，也不要把此服务放到反向代理之后。
- `next.config.ts` 设置 frame-ancestors 'none' / X-Frame-Options DENY 防止工作台被嵌入，并设置 nosniff、no-referrer 和 CORP same-origin；不设置会破坏 Next 脚本的全局 script-src，也不为本机 HTTP 设置 HSTS。

采用来源、Fetch Metadata 和非简单 JSON 请求的组合，依据 [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。无来源 CLI 是本应用的兼容性例外，不是 OWASP 的默认拒绝策略。此边界不代替 XSS 修复或操作系统权限隔离。

### 材料打开边界

`/api/files` 使用严格的判别 schema，拒绝旧的 path 参数以及额外参数。打开时先按 materialId 查材料库，再校验已保存的路径；未登记材料不读取文件。每次打开重新校验，不能因为过去选择成功就沿用信任：

- 仅绝对路径；校验原路径和 realpath 的扩展名，并排除应用/工作流等程序包内部路径。允许 PDF、普通 Office/开放文档、文本和常见图片；不支持 HTML、SVG、脚本、链接快捷方式、压缩包及 DOCM/XLSM/PPTM 等含宏扩展名。
- 使用 non-blocking/no-follow 文件描述符检查普通文件、拒绝可执行权限，并读取至多 4096 字节检查 Mach-O/ELF/MZ 可执行头及 shebang（含 UTF-8 BOM）。符号链接可以指向普通材料，但不能绕过实际目标检查。缺失/未登记返回 404，文件类型/权限/内容不允许返回 422。
- 选择器只返回通过校验的真实路径。`execFile` 使用固定命令与独立参数、无 shell，选择器 60 秒超时，打开命令 10 秒超时。`ZHAOPIN_DISABLE_FILE_OPERATIONS=1` 在自动化中禁用真实原生动作；有效文件会停在 503 禁用边界，不会弹系统窗口。
- 文件元数据保存和备份恢复仍允许不存在/受限路径，避免损失既有记录；存在不等于可安全打开。材料卡片用“路径存在”而非“文件正常”，打开错误与选择器错误可见，取消选择保留原路径。

这不是文档格式解析器或杀毒扫描。旧 DOC/XLS/PPT 或改名文件内部仍可能含宏，PDF/图片也可能有应用漏洞；不要启用不可信宏。检查与 macOS 按路径打开间仍有本机文件替换竞态，不能宣称对控制本机文件系统的攻击者提供原子保证。

隔离回归（默认生产模式，先用独立临时库迁移并构建；正式服务正在使用 `.next` 时不要重建）：

```bash
task_security_dir=$(mktemp -d /tmp/zhaopin-local-security.XXXXXX)
ZHAOPIN_TEST_DATA_DIR="$task_security_dir" node scripts/check-local-security.mjs
# 加跑真实 API/Chrome 的完整备份恢复回归（须另建全新目录）：
task_security_full_dir=$(mktemp -d /tmp/zhaopin-local-security.XXXXXX)
ZHAOPIN_TEST_DATA_DIR="$task_security_full_dir" ZHAOPIN_TEST_BACKUP_REGRESSION=1 \
  node scripts/check-local-security.mjs
```

脚本自启 3113 测试服务和 3114 其他来源，要求全新临时目录、拒绝正式库；禁用 AI、通知与系统文件动作。覆盖真实 HTTP 各接口边界、材料 ID/伪装文件、Chrome 同源写入/采集/下载/错误反馈，以及其他本地端口 no-cors/text/plain 的实际攻击请求；用 CDP 响应头状态区分服务端 403 与浏览器仅阻断读取。Node fetch 忽略自定义 Host，因此 Host 用原生 HTTP 实测。结束恢复空测试库、关闭测试服务，直接运行时截图留在临时目录供复核，复核后可移入废纸篓。单元用例 `local-request.test.ts`、`material-files.test.ts`、`files-route.test.ts` 不执行真实系统命令；全套单元测试及统一端到端入口的自动隔离见第 11 节。

## 8. 今日排序

`lib/domain.ts` 的 `compareActions()` 使用逐字段 comparator，禁止将截止和停滞相减或拼接大数分数。`compareTasks()` 复用该比较器，先把 done/skipped 放到末尾，再排序；`lib/repository.ts` 不再使用旧 `taskRank()`。时间分组为：

1. 逾期；
2. 72 小时内；
3. 7 天内；
4. 更晚或无截止。

同组依次比较 high/medium/low、绝对截止时间、最后活动时间（更早的先）、ID（稳定平局）。逾期保留原始截止，不能统一抹成零；无日期/坏日期以 Infinity 比较，用显式比较避免 Infinity-Infinity 产生 NaN。独立任务以创建时间作最后活动的兜底。优先级只在同组有效；同优先级下停滞绝不能压过更早截止。

`buildTodayPlan()` 是不依赖数据库、不修改输入的纯函数，显式接收当前时间（默认工作区 now），供固定时间测试使用。机会从最新中央映射读取，不使用任务中可能过期的机会快照。四类候选 task/milestone/deadline/nextAction 共享排序；焦点必须是清单第一项，类型/紧急组/重点优先级构成可解释理由。截止只创建核对事项，不伪造正式任务；不把下一步自动标为已完成。无候选时才用待判断→停滞复查→活跃机会作为兜底；独立任务的焦点没有关联机会，不能回落到无关岗位。

closed/skip 的所有关联事项排除，Offer 的待办任务（含下一步）/pending 节点保留，只排除投递截止；无节点日期仍可作为待安排事项。镜像字段不生成独立候选。雷达按候选顺序取 7 天内风险并按机会 ID 去重，之后追加按优先级/最后活动排序的停滞机会。停滞使用当前时钟和设置阈值计算，不直接依赖旧 stale 布尔。收件箱只取活跃 undecided，完整计数、预览 4 项。材料就绪率排除 closed/skip、保留 Offer 要求；事项计数不等同岗位计数。

TodayView 每 30 秒/窗口 focus 更新时钟，每次数据变更重新计算；不新增后台抓取或外部同步。任务（含下一步）/节点的两处完成入口共享 ref 提交锁，失败展示错误并释放锁；通用写入与刷新结果处理见第 8 项保存协议。超过 7 项可展开；截止仅提供机会核对入口。

页头日期使用 `LiveTodayDate`：服务端/客户端首次统一显示占位，在挂载后的帧回调及每 30 秒/focus 时显示当前上海日期，避免跨午夜/时钟变化下的 hydration mismatch，不能用 suppressHydrationWarning 隐藏问题。窄屏内容列使用 minmax(0,1fr) 与 min-w-0，长英文标题/组织名允许断行；仍保持准确事项标题可读。

验收用 `lib/domain.test.ts` 与 `lib/today.test.ts` 覆盖原排序漏洞、逾期顺序、72h/7d 精确边界、平局、无日期、反对称/传递性、四类事项、Offer/放弃/独立任务、停滞阈值和雷达去重。浏览器脚本验证真实 API 排序、焦点一致、失败重试、节点写盘、正确机会入口及跨日更新：

```bash
today_trial_dir=$(mktemp -d /tmp/zhaopin-today-browser.XXXXXX)
ZHAOPIN_TEST_DATA_DIR="$today_trial_dir" node scripts/check-today.mjs
```

脚本启动独立 Next 服务（默认 3112），只接受全新 `zhaopin-` 临时目录、3100–3199 端口，禁用通知和 AI。相对初始服务时间生成避开临界秒的夹具，浏览器设纽约时区；跨日检查将浏览器时钟固定到六天后，排序精确边界由固定时间单元测试覆盖。仅在已验证为空的临时库设置停滞夹具，绝不修改正式库。退出停止自己的服务并清理自己创建的记录；截图/临时库保留供复核。生产构建后另建全新目录，加 `ZHAOPIN_TEST_SERVER_MODE=start` 重跑。运行时请同时回归 `scripts/check-reminders.mjs`，确认统一时间输入和节点完成不破坏第 5 项。

## 9. 通知

通知只在服务运行期间工作。`instrumentation.ts` 注册进程内单例调度器，启动扫描一次，此后每 60 秒检查；不依赖页面保持打开。测试或非 macOS 环境不启动调度器；`ZHAOPIN_DISABLE_NOTIFICATIONS=1` 时不发送、不推进游标、不消耗业务提醒。接口地址与页面都使用回环地址，不新增外部服务。

策略与数据约定：

- 以 Asia/Shanghai 计算投递截止日期，默认提前 7、3、1、0 天的 09:00；当天截止早于 09:00 时取截止时刻。节点偏移以分钟从准确时间扣减，默认 10080、4320、1440、0；任务及有内容的下一步在到期时间提醒一次。
- 输入统一经 `toShanghaiInput/fromShanghaiInput` 转换，数据库仍保存绝对时间；不要使用宿主 `setHours/setDate/getDate` 推算上海日期。节点写接口校验真实日期；提醒偏移必须是非负整数，最多 20 个，天数上限 3650、分钟上限 5256000，保存时去重并降序排列。空数组表示关闭该项提醒。
- 机会 `closed` 或 `decision=skip` 停止全部关联提醒；Offer 停止投递截止，但保留 pending 节点及 todo/doing 任务（含下一步）。无日期、已完成/跳过节点及任务不入候选。配置损坏的单行跳过并计入状态，不影响其他有效行。
- 遍历全部未送达计划，不再只扫描过去 24 小时。`settings` 的 `reminders.cursor` 保存成功检查位置；启动、距上次超过 90 秒或新录入历史到期事项时，所有到期偏移按实体去重，合并成一条通知。游标用于判断汇总，不作为遗漏候选的下界。正常同一分钟多项到期也合并提交。
- 去重键为 `entityType:entityId:scheduledFor`。新下一步仅走 task 提醒，不产生第二个独立计划；历史 nextAction 记录仍接受备份并在迁移时映射去重，见第 4 节。修改时间会产生新键，不会误用旧时间记录阻止提醒。
- 同实例使用 in-flight Promise，跨实例使用 SQLite immediate 事务获取 30 秒租约；生产通知调用超时 10 秒，finally 仅释放自身 token。通知失败不写送达、不前移游标，保存错误并在下次检查重试。成功后将全部送达记录与游标在同一事务提交。
- 系统通知与数据库事务无法原子提交：若系统已接受而数据库提交失败/进程崩溃，后续可能重试；优先避免静默遗漏，不能承诺绝对 exactly-once。`osascript` 返回成功只证明已提交，不证明用户看到；系统权限/专注模式的视觉展示须用户在当前 Mac 验证。

`GET /api/reminders` 只读状态：环境模式、最近检查/成功游标/提交、待提交逻辑事项数、下一次未来提醒、无效配置数及错误。`POST /api/reminders` 仅接受 JSON `{ "action": "test" }`。两个入口和其他全部内部 Route Handler 一样，先执行 `guardLocalRequest()`，核对回环 Host、同源来源及请求类型；不信任转发头。测试通知记录独立，成功后 10 秒冷却，不消耗业务提醒。完整来源边界及本机 CLI 例外见第 7 节。

验证通知必须使用隔离数据库及模拟发送器，不要为自动化验收通知真实用户。`lib/reminder-engine.test.ts` 使用固定时间与实际 migration SQL，覆盖跨 48 小时停机、状态筛选、时区、去重、失败重试、事务回滚、并发租约及磁盘重启；`lib/reminders.test.ts` 模拟 OS 调用；`lib/reminder-route.test.ts` 模拟业务通知。浏览器脚本自行启动独立服务、禁用真实通知，使用纽约浏览器时区验证上海时间输入/时间线、配置持久化、节点失败重试和旧详情隔离回归，测试通知成功/失败展示由浏览器模拟。

```bash
reminder_trial_dir=$(mktemp -d /tmp/zhaopin-reminder-browser.XXXXXX)
ZHAOPIN_TEST_DATA_DIR="$reminder_trial_dir" node scripts/check-reminders.mjs
```

脚本只接受以 `zhaopin-` 开头、尚无 app.db 的临时目录和 3100–3199 端口（默认 3111），退出时停止自己启动的服务并移除自身创建的机会，直接运行时截图和数据库保留在该目录供复核。生产验收在已有新构建后用另一个全新目录加 `ZHAOPIN_TEST_SERVER_MODE=start`；不要在正式服务运行时重写共享 `.next`。全套单元测试已自动使用临时库和禁用通知；统一端到端入口另在临时副本中构建，见第 11 节。

## 10. 视觉与交互规范

- 核心背景使用温暖中性色，主色为深森林绿，风险色只用于截止或门槛；
- 页面先给决策和行动，再给统计；
- 空状态必须告诉用户下一步能做什么；
- 加载、成功、受限、重复和失败状态必须有独立文案；
- 不向用户显示 `fetch failed`、堆栈或 HTTP 库异常；
- 弹窗内长流程要分成事实、判断、下一步三个区块；
- 键盘焦点、按钮可读标签和小屏滚动必须可用。

## 11. 测试与发布检查

常规验证不需要停止正式服务：

```bash
npm run lint
npx tsc --noEmit
npm test
npm run test:isolation
npm run test:deps
npm run test:e2e -- --list
npm run test:e2e
```

### 默认单元测试隔离（第 10 项修复）

`npm test` 的 global setup 自动创建带所有权凭证的临时根，setup 在加载每个测试文件前建立独立数据库目录。即使终端继承了正式 `ZHAOPIN_DATA_DIR`、真实模型/密钥或启用系统动作的变量，也会覆盖为临时库、虚拟密钥和禁用状态；不读取正式库或钥匙串。`lib/db.ts` 在 `NODE_ENV=test` 时校验临时上下文，缺失则拒绝初始化，不回退到用户目录。

默认禁用通知、系统文件操作和钥匙串读写；未模拟的全局 `fetch` 直接拒绝。测试应显式注入或模拟网络/原生命令，不应连接真实 AI。`vi.unstubAllGlobals()` 恢复到禁止 fetch 的测试基线。需要验证原生适配器时，必须同时模拟命令调用，不能只把禁用开关改成 0。这不是阻止任意代码访问文件、HTTP 或进程的操作系统沙箱。

Vitest 只匹配 `lib/**/*.test.{ts,tsx}`、`components/**/*.test.{ts,tsx}`、`tests/unit/**/*.test.{ts,tsx}`；Playwright 只加载 `e2e/**/*.spec.ts`，不会互相扫描而触发 matcher 冲突。`npm run test:isolation` 分别在默认环境和危险的继承环境下运行完整单元测试，并核对已有哨兵数据库内容及目录未变、测试根已清理；哨兵也是临时文件，不使用正式数据。

### 独立端到端测试

`npm run test:e2e` 自动按白名单复制代码和已安装依赖到临时项目，排除 `.env*`、原项目 `.next`、用户数据与日志。在副本中先迁移空临时库，再构建生产包；随后每组测试使用另一份全新临时目录和独立 3110–3119 端口。工作流和历史组会在自有空目录建立旧版夹具库，验证启动转换。不会复用或停止 3000 正式服务，也不会覆盖它的构建。端口被其他程序占用时应报错，不自动终止该程序。

九组回归执行真实浏览器/API 断言：AI 模拟接口及坏响应回退/草稿确认、详情会话及提醒配置/上海时间、今日焦点/截止/停滞、本机来源拒绝/材料安全/备份往返、保存反馈/重复点击/事务一致性、下一步闭环/材料及要求增改删/缺失引用修复/服务重启持久化、阶段历史/真实统计/补录作废/备份重启、状态快照/活动与草稿分页/自动刷新/编辑保护、双窗口机会及关联记录冲突/任务编辑/材料版本竞争/设置/过期删除确认/核对后重建。工作流脚本 `scripts/check-workflows.mjs` 对应 `lib/workflow.test.ts`；历史脚本 `scripts/check-analytics.mjs` 对应 `lib/stage-history.test.ts`。浏览器测试不发送真实通知，不调用真实模型、钥匙串或系统文件动作；系统选择器取消通过响应夹具验证。

macOS 优先使用已安装的 Chrome；没有 Chrome 时需要 Playwright Chromium，可先执行 `npx playwright install chromium`。测试不会自动下载浏览器。可用 `npm run test:e2e -- --grep '今日焦点'` 运行一个组，仍会执行独立构建。`-- --list` 只枚举，不构建/启动服务。

日志与截图在清理临时库前附加到报告，保存在忽略提交的 `test-results/` 和 `playwright-report/`；运行 `npx playwright show-report` 查看。浏览器由子脚本创建，因此不自动生成 Playwright trace。

这些报告与 `tsconfig.tsbuildinfo` 是可再生成的开发产物，验收完成后可以移至废纸篓；下次测试会重新生成报告。不要将运行中的 `.next`、`node_modules`、数据库及其 WAL / SHM、升级备份或故障诊断日志当作测试垃圾删除。

框架正常退出或用例失败时验证所有权后清理自己生成的临时目录；超时/取消会停止自身进程组（macOS/Linux），不按端口或名称杀进程。强制杀死测试主进程、断电可能留下 `zhaopin-unit-run-*` / `zhaopin-e2e-run-*` 目录，应先核对凭证和无运行进程再处理，不能据此前缀批量删除未知文件。下文直接运行旧回归脚本的方式仍需要显式临时目录；日常优先使用上述统一入口。

### 正式生产构建

`npm run build` 修改原项目共享 `.next`，必须先停止该项目服务（见第 5 节）。构建验证应指定新建临时 `ZHAOPIN_DATA_DIR`，禁用通知、文件及钥匙串并使用虚拟 AI 配置；不要在生产构建时顺便初始化真实用户库。可先 `npm run db:migrate` 再构建，以提前发现迁移错误；直接构建空临时库也使用同一程序，写锁与事务记录保证并发初始化。成功后再通过正常启动入口恢复正式服务并检查版本、数据可读性。

涉及界面时还要在真实浏览器中验证：

- 1440×900 桌面首屏；
- 390×844 窄屏导航与弹窗；
- 空数据和包含多条机会的数据；
- 腾讯招聘链接、普通公开 HTML、动态/登录页面兜底；
- 重复 URL、取消草稿、手动纠正后保存；
- 文件已移动状态；
- JSON 导出与恢复。

发布前用隔离数据库完成端到端测试，不能把测试机会写进用户默认数据库。

完整 JSON 增加字段时，必须同步更新 `lib/backup.ts` 的对应表校验 schema，并执行一次“导出 → 清空隔离库 → 恢复 → 字段对比”。导入列名及 JSON/布尔/日期的数据库编码取自 Drizzle schema，不再维护任意列名映射。只验证导出成功是不够的。

### 备份恢复实现与验收

- `lib/backup.ts`：版本 1 严格字段校验、受限请求读取、同步一致性导出、试恢复、恢复前快照与事务替换。普通文本不 trim 或类型转换；仅日期字段支持 ISO（必须含时区、最多毫秒精度）或整数毫秒时间戳，允许声明为可空的日期使用 null。旧 v1 新增字段及可选表有明确默认值，未知字段/版本会被拒绝。
- 在修改现有数据库前验证重复 ID、重复提醒去重标识及机会/材料外键。提醒记录可保留已删除实体的历史，不将它错误地当作外键拒绝。材料路径无需文件实际存在，恢复后由材料库显示缺失状态。
- 临时内存库复用实际数据库的表 DDL 和索引，保持外键开启，按父表→子表插入、反序删除；试恢复后通过 Drizzle 读回、字段比对与 `foreign_key_check` 验证。不要直接将磁盘 WAL 数据库序列化副本作为内存库使用。
- 正式库使用 `BEGIN IMMEDIATE` 事务，先保存并 fsync 恢复前快照，再整体替换和读回核对，一次提交；异常回滚。保留现有连接，不重命名/替换运行中的 `app.db`。JSON 导出也在单个同步读事务中完成，防止多表导出混入不同时间点的数据。
- 快照保存在应用数据目录下的 `backups/`，文件以排他创建方式写入且权限为 `0600`。SQLite 快照来自 `serialize()`，包含 WAL 中的已提交数据。原数据可读且通过校验时另存可重新导入的 JSON；已损坏的原数据仅保存 SQLite 快照，仍可恢复有效备份。快照创建/写盘失败时中止恢复。
- 恢复请求流式累计最多 50 MB，支持 UTF-8 BOM。校验失败返回 400；存储或执行错误返回 500。前端恢复中禁用文件输入，成功后刷新数据及设置；连接中断只报告结果未知，避免把已提交操作误报为未执行。

独立备份测试不导入 `lib/db.ts`，只使用内存库、真实 migration SQL 和自动清理的临时目录：

```bash
npx vitest run lib/backup.test.ts
```

真实 API/Chrome 回归必须使用空临时库，不可对正式库运行。先启动测试服务（在输出中记下新建临时目录路径）：

```bash
task_data="$(mktemp -d /tmp/zhaopin-backup-check.XXXXXX)"
echo "$task_data"
ZHAOPIN_DATA_DIR="$task_data" ZHAOPIN_DISABLE_NOTIFICATIONS=1 \
  ZHAOPIN_DISABLE_FILE_OPERATIONS=1 ZHAOPIN_DISABLE_KEYCHAIN=1 \
  OPENAI_API_KEY=fake-test-key OPENAI_MODEL= OPENAI_BASE_URL=http://127.0.0.1:9/v1 \
  node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3109
```

在另一终端运行，以下路径替换成上述输出：

```bash
ZHAOPIN_TEST_DATA_DIR=/tmp/zhaopin-backup-check.实际随机后缀 \
  node scripts/check-backup-restore.mjs
```

脚本要求临时目录、非 3000 本机端口及空数据库，并核对 API 确实使用指定测试库；结束后恢复初始空数据。浏览器优先使用已安装的 macOS Chrome，否则需 Playwright Chromium。直接运行时截图及自动快照写入临时目录，停止测试服务后可删除该临时目录。该备份回归也已纳入第 11 节统一端到端套件；`npm test` 无需手动指定数据目录。

## 12. 生产启动与排障

推荐入口是 `install.command`。它通过 `scripts/macos-app.mjs` 生成用户级应用包和 LaunchAgent，然后复用 `start.command` 完成构建、注册和健康检查：

- 应用包：`~/Applications/求职助手.app`；
- LaunchAgent：`~/Library/LaunchAgents/com.local.zhaopin-assistant.plist`；
- 服务标签：`com.local.zhaopin-assistant`；
- `RunAtLoad` 保证登录后启动，`KeepAlive.SuccessfulExit=false` 只在异常退出后恢复；
- `run-server.command` 通过 `server.mjs` 启动最后成功的构建，迁移与构建由持锁启动器执行；Next 子进程异常信号退出映射为失败，以保留 launchd 异常恢复，主动关闭不误报崩溃；
- `uninstall.command` 只移除应用包和 LaunchAgent，默认保留 SQLite 数据。

未安装时，`start.command` 使用唯一临时 launchd 标签运行；已安装时核实并卸载需替换的旧作业，再 bootstrap 正式 LaunchAgent，已是当前版本则直接复用。具体身份、锁与版本协议见第 5 节。运行文件位于：

- 数据库：`~/Library/Application Support/ZhaopinAssistant/app.db`；
- 安装日志：`~/Library/Application Support/ZhaopinAssistant/install.log`；
- 启动流程日志：`~/Library/Application Support/ZhaopinAssistant/launcher.log`；
- 服务日志：`~/Library/Application Support/ZhaopinAssistant/server.log`；
- 当前服务标签缓存：`~/Library/Application Support/ZhaopinAssistant/service.label`。

排障顺序：

1. 查看 `launcher.log`；
2. 已安装时执行 `launchctl print "gui/$(id -u)/com.local.zhaopin-assistant"`；免安装模式则读取 `service.label` 后检查；
3. 查看 `server.log`；
4. 执行 `curl --noproxy '*' http://127.0.0.1:3000/api/state`；
5. 在项目目录运行三项发布检查；
6. 仍无法恢复时，先导出或复制备份，再处理数据库问题。
