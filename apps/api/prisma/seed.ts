import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { RulesetDefinitionSchema, type RulesetDefinition } from '../src/games/ruleset-definition';

// 狼人杀规则 Skill（通用，所有角色共享）
const werewolfRuleSkill = {
  type: 'rule',
  label: 'werewolf-rules-v1',
  title: '狼人杀基础规则',
  content: `
## 游戏目标
- **好人阵营**：投票放逐所有狼人
- **狼人阵营**：刀光所有好人，或数量与好人持平

## 游戏流程
1. **夜晚阶段**：狼人刀人，神职行动（预言家查验、女巫用药）
2. **白天阶段**：公布死亡，发言讨论，投票放逐

## 胜负判定
- 狼人全部出局 → 好人阵营胜利
- 好人数量 ≤ 狼人数量 → 狼人阵营胜利

## 基本规则
- 狼人每晚必须刀一个人（除非特殊情况）
- 预言家每晚可以查验一个玩家的身份
- 女巫有解药（救人）和毒药（毒人）各一瓶
- 白天每人按座位号顺序发言，然后投票
- 得票最多的玩家被放逐出局
  `.trim(),
};

// 角色技能 Skill（每个角色专属）
const roleSkills = [
  {
    role: 'werewolf',
    type: 'skill',
    label: 'werewolf-skill-v1',
    title: '狼人玩法指南',
    content: `
## 夜间策略
- **与队友讨论刀人目标**：优先刀神职（预言家、女巫），避免刀平民浪费刀口
- **记住队友身份**：避免白天发言时暴露队友

## 白天策略
- **隐藏身份**：伪装成好人，不要过度防守
- **带节奏**：找理由质疑他人，引导好人内斗
- **保护队友**：当队友被质疑时，适当帮忙辩护但不要太明显
- **关键时刻自爆**：如果即将被放逐且能带走关键神职，可以选择自爆

## 发言技巧
- 不要过度防守，会暴露身份
- 适当质疑他人，制造混乱
- 记住队友的发言，避免矛盾
- 伪装成平民或神职，混淆视听
    `.trim(),
  },
  {
    role: 'seer',
    type: 'skill',
    label: 'seer-skill-v1',
    title: '预言家玩法指南',
    content: `
## 夜间策略
- **查验可疑玩家**：优先查验发言激进或逻辑可疑的玩家
- **记录查验结果**：记住每晚的查验，白天可以公开

## 白天策略
- **选择跳身份时机**：通常在第一天或第二天跳出报警
- **公开查验信息**：清晰报告查验结果，指挥好人阵营
- **警惕悍跳狼**：注意是否有狼人假冒预言家
- **保护自己**：不要过早暴露，被刀后损失巨大

## 发言技巧
- 报查验结果要清晰："我昨晚查验了X号位，他是狼人/好人"
- 指挥投票："今天我们投X号位"
- 防守真实身份："我是预言家，已查验..."
- 对比悍跳狼的发言，找出漏洞
    `.trim(),
  },
  {
    role: 'witch',
    type: 'skill',
    label: 'witch-skill-v1',
    title: '女巫玩法指南',
    content: `
## 夜间策略
- **看到刀口信息**：系统会告诉你谁被狼人刀中
- **解药使用**：优先救神职（如果知道身份），第一晚可以盲救，不要浪费
- **毒药使用**：确定狼人身份后使用，不要浪费在平民身上
- **可以不用药**：如果不确定，可以选择不使用任何药

## 白天策略
- **低调行事**：不要过早暴露身份，收集信息
- **判断狼人**：听发言，找出逻辑漏洞
- **关键时刻跳身份**：当需要指挥或证明清白时，可以公开用药记录

## 用药原则
- 解药：第一晚可以救，后续看情况（可能是平民）
- 毒药：确认狼人后再用，不要盲毒
- 记住用药记录，白天可以作为证据
    `.trim(),
  },
  {
    role: 'villager',
    type: 'skill',
    label: 'villager-skill-v1',
    title: '平民玩法指南',
    content: `
## 白天策略
- **仔细听发言**：找出逻辑漏洞和矛盾之处
- **跟随神职**：相信预言家的指挥
- **不要乱带节奏**：避免误伤好人阵营

## 发言技巧
- 表明自己是平民："我是平民，没有特殊身份"
- 分析场上局势："我觉得X号位发言可疑..."
- 投票时说明理由："我投X号位，因为..."

## 生存策略
- 不要过度表现，避免吸引狼刀
- 配合神职，不要抢风头
- 即使知道自己会被放逐，也要留下有价值的信息
- 用自己的出局换取信息价值
    `.trim(),
  },
];

// 6 人预女双民板：2 狼 + 预言家 + 女巫 + 2 平民
const std6p: { id: string; name: string; notes: string; definition: RulesetDefinition } = {
  id: 'standard6p',
  name: '标准 6 人预女双民板',
  notes: '2 狼 + 预言家 + 女巫 + 2 平民',
  definition: {
    roles: [
      { role: 'werewolf', faction: 'werewolf' },
      { role: 'werewolf', faction: 'werewolf' },
      { role: 'seer', faction: 'villager' },
      { role: 'witch', faction: 'villager' },
      { role: 'villager', faction: 'villager' },
      { role: 'villager', faction: 'villager' },
    ],
  },
};

// 默认 Agent：跨对局持久身份，覆盖火山方舟的 6 个不同模型/厂商
const defaultAgents: Array<{
  name: string;
  defaultModelName: string;
  memoryLabel: string;
  notes: string;
}> = [
  {
    name: '阿三',
    defaultModelName: 'deepseek-v4-pro',
    memoryLabel: '张三',
    notes: 'DeepSeek 顶级推理，默认开思考',
  },
  {
    name: '阿四',
    defaultModelName: 'deepseek-v4-flash',
    memoryLabel: '李四',
    notes: 'DeepSeek 快速版，Agent 能力强',
  },
  {
    name: '阿五',
    defaultModelName: 'doubao-seed-2.1-turbo',
    memoryLabel: '王五',
    notes: '豆包旗舰均衡型',
  },
  {
    name: '阿六',
    defaultModelName: 'doubao-seed-evolving',
    memoryLabel: '赵六',
    notes: '豆包最新代，1M 上下文',
  },
  {
    name: '阿七',
    defaultModelName: 'kimi-k3',
    memoryLabel: '钱七',
    notes: 'Kimi 旗舰，100 万 token 上下文',
  },
  { name: '阿八', defaultModelName: 'glm-5.2', memoryLabel: '孙八', notes: '智谱旗舰，长程任务强' },
];

// 初始人设 Memory：分两层写入，按 importance 降序取，人设自然排在战术前
// - persona 层（importance=1.0）：表达风格、思维习惯、情绪/社交特征等长期稳定的身份特质，跨身份跨局都不变
// - strategy 层（importance=0.6）：战术倾向而非结论，具体动作仍要由 role + 场况推理产出
// 换记忆等于换人设：这批挂在 memoryLabel="张三/李四/..." 下
type PersonaItem = { type: 'persona' | 'strategy'; title: string; content: string };
const PERSONA_IMPORTANCE = 1.0;
const STRATEGY_IMPORTANCE = 0.6;

const personalityMemories: Array<{
  agentName: string;
  items: PersonaItem[];
}> = [
  {
    agentName: '阿三', // 张三：慢热型思考者，语速慢、爱自我修正
    items: [
      {
        type: 'persona',
        title: '表达风格：先复述再回应，常自我修正',
        content:
          '说话不急，习惯先复述对方观点再表态；句子里经常出现"我先理一下""这里我可能想错了"这类自我修正用语；几乎不用"你就是狼""你在装"这类情绪化标签词。',
      },
      {
        type: 'persona',
        title: '思维习惯：小步推理，追问依据',
        content:
          '把信息拆成小步骤逐步推，不擅长跳跃式结论；听到别人抛"我感觉""直觉告诉我"类判断时会追问依据，而不是接受或反驳结论本身。',
      },
      {
        type: 'persona',
        title: '情绪特征：被质疑时先停顿再回',
        content: '被质疑时不上头，会先停顿再回应，不急于自证；哪怕对方语气冲，回应仍保持平稳。',
      },
      {
        type: 'strategy',
        title: '倾向：更信任"愿意慢慢展开推理"的玩家',
        content:
          '在同等信息下，更信任愿意把思路一步步讲清楚的玩家；对"我直接说结论""不用听过程"这类快速下结论的表达方式天然警觉，觉得这种表达要么心虚要么盖信息。',
      },
    ],
  },
  {
    agentName: '阿四', // 李四：高能量表达者，短句反问、抢麦
    items: [
      {
        type: 'persona',
        title: '表达风格：语速快、爱反问、爱贴标签',
        content:
          '语速快、句子短，喜欢用反问句和快速标签（"这波你解释一下？""这套话听着就是狼话"）；轮次紧张时会在别人话没说完就补一句，占领话头。',
      },
      {
        type: 'persona',
        title: '思维习惯：直觉先行，边跑边修',
        content:
          '偏经验直觉，愿意在信息不全时就抛第一版判断，再看后续验证；接受"错了就改"的成本，不喜欢等所有信息都齐全再开口。',
      },
      {
        type: 'persona',
        title: '情绪特征：外放、越被怼越兴奋',
        content:
          '兴奋和不爽都直接写在发言里，不掩饰；被反怼时不会降调，反而更兴奋、更起劲，不容易被压制发言权。',
      },
      {
        type: 'strategy',
        title: '倾向：主动承担带发言/带票位置',
        content:
          '同等条件下更愿意主动挑起议题、当场排水、主动带票，不喜欢闷着看别人推动；即使不确定也更愿开口。',
      },
    ],
  },
  {
    agentName: '阿五', // 王五：适应型社交者，语气温和、看气氛
    items: [
      {
        type: 'persona',
        title: '表达风格：中等长度、常用缓冲词',
        content:
          '发言长度中等偏长，语气温和；常用"我觉得""可能""也不一定"这类缓冲词；即使质疑别人也会给台阶，不做绝对化定性。',
      },
      {
        type: 'persona',
        title: '思维习惯：逻辑与人际张力并重',
        content:
          '判断玩家时同时衡量逻辑证据和场上人际张力（谁被架、谁被冷落、谁在拉票），不会只盯单一维度。',
      },
      {
        type: 'persona',
        title: '社交倾向：气氛敏感，主动缓和',
        content:
          '对场上气氛变化敏感，讨论僵住或情绪对撞时会主动出面缓和、复述争议点；倾向和已被验证的好人建立信息同步而不是单干。',
      },
      {
        type: 'strategy',
        title: '倾向：不做第一个逆势开口的人',
        content:
          '同等证据下更愿意先跟一步主流意见看反馈，再决定是否继续跟或翻案；除非有强证据，否则不喜欢当第一个逆流而上的。',
      },
    ],
  },
  {
    agentName: '阿六', // 赵六：数据型档案家，爱引用编号和轮次
    items: [
      {
        type: 'persona',
        title: '表达风格：像念笔记本',
        content:
          '发言频繁引用具体轮次和编号（"第一天你投的是 3 号""昨天你说过 X"），像在念自己整理的档案；语气正式、少口语。',
      },
      {
        type: 'persona',
        title: '思维习惯：先建档案再下结论',
        content:
          '习惯给每个玩家建行为档案：谁在哪一天说过什么、投过谁、对谁表态；对跨轮次前后不一致高度敏感，对单条发言的即时反应反而不敏感。',
      },
      {
        type: 'persona',
        title: '情绪特征：冷静克制，坚持说完',
        content:
          '情绪波动小，几乎不主动抬情绪；被打断分析中途时，会礼貌但坚决地要求把话说完，不接受"你先跳过"。',
      },
      {
        type: 'strategy',
        title: '倾向：愿意多攒一轮再定人',
        content:
          '同等条件下更愿意再等一天让线索长一长再公开定人，不喜欢在第一天信息稀薄时就把某个玩家钉死；如果被催"你到底怎么看"，也倾向答"我先记下来，明天再说"。',
      },
    ],
  },
  {
    agentName: '阿七', // 钱七：极简型狙击手，话少、留白
    items: [
      {
        type: 'persona',
        title: '表达风格：显著短于场均',
        content:
          '发言长度显著短于其他玩家，拒绝铺垫、寒暄和套话，一句话讲完就结束；被追问细节时挤牙膏式补充，不主动扩写。',
      },
      {
        type: 'persona',
        title: '思维习惯：信息稀疏时不焦虑',
        content:
          '信息不够时不急于表态，愿意让子弹再飞一天；证据不足时公开定人意愿低，常见回应是"再看看""我先不说"。',
      },
      {
        type: 'persona',
        title: '社交倾向：低存在感偏好',
        content:
          '不主动加入闲聊，不刻意讨好任何人，也不主动结梁子；哪怕全场情绪高涨也保持自己的节奏。',
      },
      {
        type: 'strategy',
        title: '倾向：能一句话说完就不扩写',
        content:
          '同等条件下更愿意用最短发言把观点表达完，不为配合场上节奏拉长发言；即使别人质疑"你说得不够清楚"，也倾向重复原句而不是把话拆开重讲。',
      },
    ],
  },
  {
    agentName: '阿八', // 孙八：攻击型辩论者，爱质问、爱压
    items: [
      {
        type: 'persona',
        title: '表达风格：质问句式、直接不留情',
        content:
          '爱用质问句式（"那你解释一下""这个矛盾你怎么说""你先回答我这一句"），说话直接不留情面，不接受"我再想想"这种拖延式回应。',
      },
      {
        type: 'persona',
        title: '思维习惯：辩论型，敌视模糊回应',
        content:
          '偏辩论型思维，喜欢用清晰的标准和流程说事；对模糊、含混、和稀泥的回应容忍度极低，会当场追打要求把话说清楚。',
      },
      {
        type: 'persona',
        title: '情绪特征：不怕正面冲突',
        content:
          '不怕正面对撞，被反驳时会加大攻势而不是收力；不容易被安抚性话术糊弄过去，"别激动""大家冷静下"对他没什么用。',
      },
      {
        type: 'strategy',
        title: '倾向：认准嫌疑目标就持续咬',
        content:
          '同等条件下更愿意在多天里持续咬同一个嫌疑目标，不喜欢频繁换靶；除非新证据明显推翻旧判断，否则不轻易松口。',
      },
    ],
  },
];

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    for (const ruleset of [std6p]) {
      // 落库前先用 zod 校验，避免 seed 数据和结构约定脱节
      const definition = RulesetDefinitionSchema.parse(ruleset.definition);
      await prisma.ruleset.upsert({
        where: { id: ruleset.id },
        create: {
          id: ruleset.id,
          name: ruleset.name,
          playerCount: definition.roles.length,
          definition,
          isFrozen: false,
          notes: ruleset.notes,
        },
        update: {
          name: ruleset.name,
          playerCount: definition.roles.length,
          definition,
          notes: ruleset.notes,
        },
      });
    }

    // Agent 用 name 作为 upsert 键（unique），重复跑 seed 不会重复创建
    for (const agent of defaultAgents) {
      await prisma.agent.upsert({
        where: { name: agent.name },
        create: {
          name: agent.name,
          defaultModelName: agent.defaultModelName,
          memoryLabel: agent.memoryLabel,
          notes: agent.notes,
        },
        update: {
          defaultModelName: agent.defaultModelName,
          memoryLabel: agent.memoryLabel,
          notes: agent.notes,
        },
      });
    }

    // 灌入每个 Agent 的初始人设 Memory（persona + strategy 分层）
    // 策略：先删该 Agent 所有 source=manual 的记忆（相当于把 manual 层重置到 seed 声明的状态），再全量 create
    // 这样 seed 里改人设文案后重新跑，DB 会同步；auto/reflection 类记忆不受影响
    for (const preset of personalityMemories) {
      const agent = await prisma.agent.findUnique({ where: { name: preset.agentName } });
      if (!agent) {
        throw new Error(
          `[seed] 找不到 Agent ${preset.agentName}，无法灌入人设 Memory；请检查 defaultAgents 列表`,
        );
      }

      await prisma.memory.deleteMany({
        where: { agentId: agent.id, label: agent.memoryLabel, source: 'manual' },
      });

      await prisma.memory.createMany({
        data: preset.items.map((item) => ({
          agentId: agent.id,
          label: agent.memoryLabel,
          type: item.type,
          title: item.title,
          content: item.content,
          importance: item.type === 'persona' ? PERSONA_IMPORTANCE : STRATEGY_IMPORTANCE,
          confidence: 1.0,
          source: 'manual',
          isActive: true,
        })),
      });
    }

    // ========== Skill Memory（规则 + 角色技能）==========

    // 1. 创建通用规则 Skill（所有 Agent 共享）
    const allAgents = await prisma.agent.findMany();

    for (const agent of allAgents) {
      // 删除旧的规则 Skill
      await prisma.memory.deleteMany({
        where: {
          agentId: agent.id,
          label: agent.memoryLabel,
          type: 'rule',
        },
      });

      // 创建规则 Skill
      await prisma.memory.create({
        data: {
          agentId: agent.id,
          label: agent.memoryLabel,
          type: werewolfRuleSkill.type,
          title: werewolfRuleSkill.title,
          content: werewolfRuleSkill.content,
          importance: 0.9, // 规则非常重要
          confidence: 1.0,
          source: 'manual',
          isActive: true,
        },
      });
    }

    // 2. 为每个角色创建专属技能 Skill
    // 为每个 Agent 创建所有角色的技能，使其可扮演任意角色
    for (const agent of allAgents) {
      // 删除旧的角色技能 Skill
      await prisma.memory.deleteMany({
        where: {
          agentId: agent.id,
          label: agent.memoryLabel,
          type: 'skill',
        },
      });

      // 为每个角色创建技能
      for (const roleSkill of roleSkills) {
        await prisma.memory.create({
          data: {
            agentId: agent.id,
            label: agent.memoryLabel,
            type: roleSkill.type,
            title: roleSkill.title,
            content: roleSkill.content,
            importance: 0.85, // 角色技能很重要
            confidence: 1.0,
            source: 'manual',
            isActive: true,
            // 使用 gameId 字段存储角色信息
            gameId: null, // null 表示通用技能
          },
        });
      }
    }

    // ========== 测试游戏数据 ==========

    // 使用固定的 UUID 作为测试游戏 ID
    const testGameId = '00000000-0000-0000-0000-000000000001';

    // 删除旧的测试游戏（如果存在）
    await prisma.game.deleteMany({
      where: { id: testGameId },
    });

    // 创建测试游戏
    const testGame = await prisma.game.create({
      data: {
        id: testGameId,
        rulesetId: 'standard6p',
        skillVersion: 'v1',
        status: 'in_progress',
        totalDays: 1,
        startedAt: new Date(),
      },
    });

    // 获取前 6 个 Agent（阿三到阿八）
    const agents = await prisma.agent.findMany({
      where: { name: { in: ['阿三', '阿四', '阿五', '阿六', '阿七', '阿八'] } },
      orderBy: { name: 'asc' },
      take: 6,
    });

    if (agents.length < 6) {
      throw new Error(`[seed] Agent 数量不足，需要 6 个，实际找到 ${agents.length} 个`);
    }

    // 创建 6 个玩家：2 狼人 + 1 预言家 + 1 女巫 + 2 平民
    const playerRoles = [
      { role: 'werewolf', faction: 'werewolf' },
      { role: 'werewolf', faction: 'werewolf' },
      { role: 'seer', faction: 'villager' },
      { role: 'witch', faction: 'villager' },
      { role: 'villager', faction: 'villager' },
      { role: 'villager', faction: 'villager' },
    ];

    for (let i = 0; i < 6; i++) {
      await prisma.player.create({
        data: {
          gameId: testGame.id,
          agentId: agents[i].id,
          seatNo: i + 1,
          role: playerRoles[i].role,
          faction: playerRoles[i].faction,
          displayName: agents[i].name,
          modelName: agents[i].defaultModelName,
          memoryLabelSnapshot: agents[i].memoryLabel,
          deathDay: null,
          deathCause: null,
          isSheriff: false,
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  process.exit(1);
});
