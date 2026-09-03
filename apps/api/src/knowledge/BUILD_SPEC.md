# 攻略知识库构建管线规范（build-knowledge-chunks）

## 目标

把 `data/cleaned/` 三份已清洗攻略（juese-clean.md / mengxin-clean.md / jiaoxue-clean.md）切块、LLM 蒸馏成
`{role, scenario, trigger, action}` 结构化条目、embedding 向量化、落库 `knowledge_chunks` 表。

## 产物

单文件脚本 `apps/api/src/knowledge/build-knowledge-chunks.ts`（仿 `apps/api/src/memory/backfill-lesson-trigger.ts` 的
standalone + PrismaPg + PrismaClient 范式）。package.json 加脚本 `knowledge:build`。

## 输入约定

三份清洗文件均为 `---` 行分隔多篇文章，每篇以 `## ` 开头（文章标题），正文用 `### ` 小节锚点。
清洗产物满足：无 HTML 标签、无 `@作者`、无文章ID/日期、无 `▼`/`★`/`☆` 装饰符、无视频/图片 URL；
全角空格 `　`、ASCII 空格、空行仅作视觉分隔（可合并）。原文与蒸馏条目双写同一行。

## 切块规则

1. 按 `---` 拆文章，保留 `## 标题` 作 `article_title`。
2. 以 `### 小节` 为基本单元；相邻小节合并到 300~500 字（超长单小节 800+ 字可独立成块，不必硬拆）。
3. 无 `###` 章节的文章（如新手术语、位置玄学），按段落（空行分组）聚合成 300~500 字块，
   `section_title` 置空。语义完整优先，避免把小节拦腰斩断。
4. 每块记录 `source_file`（juese-clean.md 等）、`article_title`、`section_title`、`content`（清洗后原文，可含 `###` 标题行）。

## 蒸馏 schema

```
{
  role: string         // 适用角色，来自 packages/shared ROLES 的英文枚举，或 'any'（对任意身份成立）
  scenario: string     // vote|day_speech|night_action|last_words|sheriff_decide_order，或 'any'（跨场景）
  trigger: string      // 触发条件：什么局面下这条战术适用（可复现的局面描述，不含座位号/具体玩家）
  action: string       // 该局面下具体怎么做（可执行、面向该角色的操作建议）
}
```

蒸馏 prompt（SystemMessage）：

- 你是狼人杀攻略蒸馏器。把一段攻略正文提炼成一条结构化战术条目，供 agent 对局决策时按局面检索注入。
- role：这段正文主要适用于哪个角色，用英文枚举（villager/seer/witch/hunter/guard/idiot/dreamweaver/thief/cupid/werewolf/wolf_king/white_wolf/wolf_beauty/demon 等）；对任何身份都成立或讲的是通用能力（抿人、表水、位置学、术语，不专属某角色）填 `any`。**不把 `any` 当默认值**，正文明确讲某角色玩法就必须填该角色。
- scenario：这段正文主要适用于哪个场景（vote=投票/day_speech=白天发言/night_action=夜间行动/last_words=遗言/sheriff_decide_order=警长定序）；跨场景或讲的是角色整个对局定位才填 `any`。
- trigger：用一两句话描述「什么局面下该参考这条战术」，必须是可复现的局面条件（如
  「我是预言家，警上前置位有悍跳狼时」），不要写「我是预言家」这种没有局面条件的大类描述，也不要包含座位号/具体玩家。
- action：该局面下具体怎么做（2~4 句，含该角色视角的战术动作），不是重复 trigger。

## embedding

- 模型 `ARK_EMBEDDING_MODEL`（.env 缺省 `doubao-embedding-vision`，务必与 `EmbeddingService.model` 一致）。
- 单次请求 input 上限 10 条，必须手动按 10 条分批（仿 `EmbeddingService.embedTexts`）。
- 向量 2048 维；写库前校验维度与数值有效（对齐 `assertValidVector`）。
- 每块一个向量，逐块 `$executeRaw` UPDATE 到 `knowledge_chunks`：
  ```
  UPDATE knowledge_chunks
  SET embedding = $1::vector, embedding_model = $2, embedding_dimension = 2048,
      embedding_content_hash = $3, embedded_at = NOW()
  WHERE id = $4::uuid AND content = $5
  ```
  `embedding_content_hash` = sha256(content)（仿 `hashMemoryContent`）。

## 检索 key（必须与 KnowledgeService 对齐）

- `role`、`scenario` 都是单值字符串，区分大小写小写。
- 蒸馏出的 role/scenario 必须落在 shared ROLES / AGENT_SCENARIOS 枚举（或 'any'）内，不要臆造新值。
- 预测命中判定：检索时 `AND (scenario = $scenario OR scenario='any')` + `AND (role = $role OR role='any')`。
  **所以：一篇角色明确（女巫/预言家）的正文绝不标 `any`，否则会错误注入给平民等任何角色。**

## 落库

- 逐块 INSERT（`id` 用 `gen_random_uuid()` 或 uuidv4），幂等可重跑：脚本开头可选 `TRUNCATE knowledge_chunks`（加 `--reset` 参数）或 `DELETE FROM knowledge_chunks WHERE source_file = $file` 后重建。
- 每插入一块打印进度（成功/失败计数），失败不中断（下批重跑补）。
- 完成后打印总块数、role/scenario 取值分布，供人工核查。

## 成功标准

- 运行 `pnpm knowledge:build`（apps/api 下）成功，`knowledge_chunks` 落库约 90~~200 块（清洗后约 24 篇 → 目标 90~~200 块）。
- 每块 `role`/`scenario` 为合法枚举或 `any`，`embedding` 非空，`embedding_dimension`=2048。
- 可重复运行（失败后可安全重跑，不产生重复数据）。
- 用若干 query 冒烟：女巫夜间行动、预言家被悍跳、倒钩狼等，检索能命中对应篇目的块。
