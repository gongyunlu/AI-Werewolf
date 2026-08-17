import type { Game, GamesListResponse } from '@/types/game';

export interface Ruleset {
  id: string;
  name: string;
  playerCount: number;
}

export interface Agent {
  id: string;
  name: string;
  defaultModelName: string;
  isActive: boolean;
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
   */
  async getGame(gameId: string): Promise<Game> {
    const response = await fetch(`${this.baseURL}/games/${gameId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch game: ${response.statusText}`);
    }
    const data = await response.json();

    // 字段映射：后端 -> 前端
    return {
      id: data.id,
      status: data.status,
      phase: data.phase || 'night',
      currentRound: data.currentRound || 1,
      currentSpeaker: data.currentSpeaker || null,
      players: (data.players || []).map((p: any) => ({
        seatNumber: p.seatNo,
        name: p.displayName,
        role: p.role,
        camp: p.faction,
        status: p.deathDay === null ? 'alive' : 'dead',
        votedFor: p.votedFor || null,
        isProtected: p.isProtected || false,
        isPoisoned: p.isPoisoned || false,
        isSilenced: p.isSilenced || false,
      })),
      createdAt: data.createdAt || new Date().toISOString(),
      startedAt: data.startedAt,
      finishedAt: data.endedAt,
    };
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
   */
  async getAgents(): Promise<Agent[]> {
    const response = await fetch(`${this.baseURL}/agents`);
    if (!response.ok) throw new Error(`Failed to fetch agents: ${response.statusText}`);
    return response.json();
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

  /**
   * 初始化对局（分配角色）
   */
  async initializeGame(gameId: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/games/${gameId}/initialize`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error(`Failed to initialize game: ${response.statusText}`);
  }

  /**
   * 开始对局
   */
  async startGame(gameId: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/games/${gameId}/start`, { method: 'POST' });
    if (!response.ok) throw new Error(`Failed to start game: ${response.statusText}`);
  }

  /**
   * 恢复对局（从 pending_recovery 状态恢复）
   */
  async recoverGame(gameId: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/games/admin/recover-game/${gameId}`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error(`Failed to recover game: ${response.statusText}`);
  }

  /**
   * 创建 SSE 连接
   */
  createSSEConnection(gameId: string): EventSource {
    return new EventSource(`${this.baseURL}/games/${gameId}/stream`);
  }
}

export const apiClient = new ApiClient(API_BASE_URL);
