import type { GameListItem, GamesListResponse } from '@/types/game';
import { getAdminToken } from './admin-token';

export interface Ruleset {
  id: string;
  name: string;
  playerCount: number;
}

export interface Agent {
  id: string;
  name: string;
  defaultModelName: string;
  memoryLabel: string;
  isActive: boolean;
  /** Agent 自带的接入端点；为空表示走服务端环境变量里的默认接入 */
  baseUrl: string | null;
  /** 是否已配置自带密钥；读接口只给这个布尔值和掩码，永不给明文 */
  hasApiKey: boolean;
  /** 密钥末 4 位掩码，未配置时为 null */
  apiKeyMasked: string | null;
  /** 单值自由文本标签，只用于识别与筛选，不参与模型路由 */
  tag: string | null;
  notes: string | null;
}

/** 接入配置与标签的写入口径：字段缺省=保持原值，null=清除，有值=覆盖 */
export interface AgentUpdateInput {
  defaultModelName?: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  tag?: string | null;
  notes?: string;
  isActive?: boolean;
}

/** 人设/策略条目；分层由后端按 type 决定，前端只需给标题与正文 */
export interface PersonaStrategyItem {
  title: string;
  content: string;
}

/** 读回来的条目额外带 id 与重要度分层，保存时只提交标题与正文 */
export interface PersonaStrategyEntry extends PersonaStrategyItem {
  id: string;
  importance: number;
}

export interface PersonaStrategyView {
  label: string;
  persona: PersonaStrategyEntry[];
  strategy: PersonaStrategyEntry[];
}

/** 赛后分析进度 */
export interface AnalysisStatus {
  judgedCount: number;
  judgeableCount: number;
  judgeComplete: boolean;
  reflectedCount: number;
  playerCount: number;
  narrativeReady: boolean;
}

export interface AnalyzeGameOptions {
  judge?: boolean;
  reflect?: boolean;
  playerId?: string;
  force?: boolean;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

class ApiClient {
  private baseURL: string;

  constructor(baseURL: string) {
    this.baseURL = baseURL;
  }

  /**
   * 获取对局列表
   */
  async getGames(params?: {
    page?: number;
    pageSize?: number;
    status?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<GamesListResponse> {
    const queryParams = new URLSearchParams();
    if (params?.page) queryParams.set('page', params.page.toString());
    if (params?.pageSize) queryParams.set('pageSize', params.pageSize.toString());
    if (params?.status) queryParams.set('status', params.status);
    if (params?.sortBy) queryParams.set('sortBy', params.sortBy);
    if (params?.sortOrder) queryParams.set('sortOrder', params.sortOrder);

    const response = await fetch(`${this.baseURL}/games?${queryParams.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch games: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * 获取单个对局详情
   *
   * 后端返回原始 Prisma 结构（players 含 seatNo/displayName/role/faction/modelName/isSheriff 等），
   * 直接透传给观战页使用，不做字段重命名。
   */
  async getGame(gameId: string): Promise<GameListItem> {
    const response = await fetch(`${this.baseURL}/games/${gameId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch game: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * 获取规则集列表
   */
  async getRulesets(): Promise<Ruleset[]> {
    const response = await fetch(`${this.baseURL}/rulesets`);
    if (!response.ok) throw new Error(`Failed to fetch rulesets: ${response.statusText}`);
    return response.json();
  }

  /**
   * 获取 Agent 列表
   *
   * @param includeInactive - 是否带上已停用的 Agent；默认只返回活跃的
   */
  async getAgents(includeInactive = false): Promise<Agent[]> {
    const query = includeInactive ? '?includeInactive=true' : '';
    const response = await fetch(`${this.baseURL}/agents${query}`);
    if (!response.ok) throw new Error(`Failed to fetch agents: ${response.statusText}`);
    return response.json();
  }

  /** 管理写接口统一带 x-admin-token；令牌为空时后端会明确拒绝，前端不自行放行。 */
  private async adminRequest<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseURL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': getAdminToken(),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const message = Array.isArray(err.message) ? err.message.join('；') : err.message;
      throw new Error(message || `请求失败：${response.statusText}`);
    }
    return response.json();
  }

  /** 更新 Agent 的模型/接入端点/密钥/标签/备注；密钥只写不读 */
  updateAgent(id: string, input: AgentUpdateInput): Promise<Agent> {
    return this.adminRequest(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  }

  /** 读取 Agent 的人设与策略；label 缺省时用该 Agent 当前的记忆集 */
  async getPersonaStrategy(agentId: string, label?: string): Promise<PersonaStrategyView> {
    const query = label ? `?label=${encodeURIComponent(label)}` : '';
    const response = await fetch(
      `${this.baseURL}/agents/${agentId}/memories/persona-strategy${query}`,
    );
    if (!response.ok) throw new Error(`读取人设失败：${response.statusText}`);
    return response.json();
  }

  /** 整批替换 Agent 的人设与策略；旧条目由后端归档保留 */
  replacePersonaStrategy(
    agentId: string,
    input: { persona: PersonaStrategyItem[]; strategy: PersonaStrategyItem[] },
    label?: string,
  ): Promise<PersonaStrategyView> {
    const query = label ? `?label=${encodeURIComponent(label)}` : '';
    return this.adminRequest(`/agents/${agentId}/memories/persona-strategy${query}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  /**
   * 创建对局
   */
  async createGame(dto: { rulesetId: string; agentIds: string[] }): Promise<{ id: string }> {
    const response = await fetch(`${this.baseURL}/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `Failed to create game: ${response.statusText}`);
    }
    return response.json();
  }

  /** 同一配置启动一对 ON/OFF，沿用批量配对接口。 */
  async startAbGames(dto: {
    rulesetId: string;
    agentIds: string[];
  }): Promise<{ gameIds: string[]; experimentId: string }> {
    const response = await fetch(`${this.baseURL}/evaluation/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...dto,
        count: 1,
        shuffleAgents: false,
        experiment: { paired: true, start: true },
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `启动 A/B 对局失败：${response.statusText}`);
    }
    return response.json();
  }

  /**
   * 初始化对局（分配角色）
   */
  async initializeGame(gameId: string): Promise<GameListItem> {
    const response = await fetch(`${this.baseURL}/games/${gameId}/initialize`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error(`Failed to initialize game: ${response.statusText}`);
    return response.json();
  }

  /**
   * 开始对局
   */
  async startGame(gameId: string): Promise<GameListItem> {
    const response = await fetch(`${this.baseURL}/games/${gameId}/start`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to start game: ${response.statusText}`);
    return response.json();
  }

  /**
   * 恢复对局（从 pending_recovery 状态恢复）
   */
  async recoverGame(gameId: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/games/admin/recover-game/${gameId}`, {
      method: 'POST',
    });
    if (!response.ok) {
      // 拒绝的原因（指纹变化、期限已到、状态不符）只在响应体里，不能用 statusText 顶替
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `恢复对局失败：${response.statusText}`);
    }
  }

  /**
   * 查询单局赛后分析进度
   */
  async getAnalysisStatus(gameId: string): Promise<AnalysisStatus> {
    const response = await fetch(`${this.baseURL}/evaluation/games/${gameId}/analysis-status`);
    if (!response.ok) throw new Error(`Failed to fetch analysis status: ${response.statusText}`);
    return response.json();
  }

  /**
   * 触发单局赛后分析（评分 / 复盘 / 反思）
   */
  async analyzeGame(
    gameId: string,
    options: AnalyzeGameOptions = {},
  ): Promise<{
    judged: number;
    reflectPlanned: number;
    /** 是否实际投递；false 表示因已有流程在运行/已完成等原因被跳过 */
    skipped: boolean;
  }> {
    const response = await fetch(`${this.baseURL}/evaluation/games/${gameId}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `Failed to analyze game: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * 创建 SSE 连接
   */
  createSSEConnection(gameId: string, opts: { perspective?: string } = {}): EventSource {
    const params = new URLSearchParams();
    if (opts.perspective) params.set('perspective', opts.perspective);
    const query = params.toString();
    return new EventSource(`${this.baseURL}/games/${gameId}/stream${query ? `?${query}` : ''}`);
  }
}

export const apiClient = new ApiClient(API_BASE_URL);
