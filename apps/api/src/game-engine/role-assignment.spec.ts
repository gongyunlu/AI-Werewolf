import { assignRolesAndSeats } from './role-assignment';
import type { RoleAssignment } from '../games/ruleset-definition';

describe('assignRolesAndSeats', () => {
  describe('基础分配', () => {
    it('应该为每个 Agent 分配唯一座位号（1开始）', () => {
      const roles: RoleAssignment[] = [
        { role: 'werewolf', faction: 'werewolf' },
        { role: 'werewolf', faction: 'werewolf' },
        { role: 'villager', faction: 'villager' },
      ];
      const agentIds = ['agent-1', 'agent-2', 'agent-3'];

      const result = assignRolesAndSeats(roles, agentIds);

      const seatNos = result.map((r) => r.seatNo);
      expect(seatNos).toHaveLength(3);
      expect(new Set(seatNos).size).toBe(3); // 座位号唯一
      expect(Math.min(...seatNos)).toBe(1); // 从1开始
      expect(Math.max(...seatNos)).toBe(3);
    });

    it('应该为每个 Agent 分配一个角色', () => {
      const roles: RoleAssignment[] = [
        { role: 'werewolf', faction: 'werewolf' },
        { role: 'seer', faction: 'villager' },
        { role: 'villager', faction: 'villager' },
      ];
      const agentIds = ['agent-1', 'agent-2', 'agent-3'];

      const result = assignRolesAndSeats(roles, agentIds);

      expect(result).toHaveLength(3);
      result.forEach((assignment) => {
        expect(assignment.agentId).toBeDefined();
        expect(assignment.role).toBeDefined();
        expect(assignment.faction).toBeDefined();
        expect(assignment.seatNo).toBeDefined();
      });
    });

    it('应该消耗掉所有角色配置', () => {
      const roles: RoleAssignment[] = [
        { role: 'werewolf', faction: 'werewolf' },
        { role: 'werewolf', faction: 'werewolf' },
        { role: 'seer', faction: 'villager' },
        { role: 'villager', faction: 'villager' },
      ];
      const agentIds = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];

      const result = assignRolesAndSeats(roles, agentIds);

      const assignedRoles = result.map((r) => r.role).toSorted();
      const expectedRoles = roles.map((r) => r.role).toSorted();
      expect(assignedRoles).toEqual(expectedRoles);
    });

    it('应该消耗掉所有 Agent', () => {
      const roles: RoleAssignment[] = [
        { role: 'werewolf', faction: 'werewolf' },
        { role: 'seer', faction: 'villager' },
        { role: 'villager', faction: 'villager' },
      ];
      const agentIds = ['agent-1', 'agent-2', 'agent-3'];

      const result = assignRolesAndSeats(roles, agentIds);

      const assignedAgents = result.map((r) => r.agentId).toSorted();
      expect(assignedAgents).toEqual([...agentIds].toSorted());
    });
  });

  describe('随机性', () => {
    it('多次调用应产生不同的角色-Agent配对', () => {
      const roles: RoleAssignment[] = [
        { role: 'werewolf', faction: 'werewolf' },
        { role: 'werewolf', faction: 'werewolf' },
        { role: 'seer', faction: 'villager' },
        { role: 'witch', faction: 'villager' },
        { role: 'hunter', faction: 'villager' },
        { role: 'villager', faction: 'villager' },
      ];
      const agentIds = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5', 'agent-6'];

      const results = Array.from({ length: 10 }, () => assignRolesAndSeats(roles, agentIds));

      // 将每次结果序列化为字符串方便对比
      const signatures = results.map((r) =>
        r
          .toSorted((a, b) => a.seatNo - b.seatNo)
          .map((x) => `${x.seatNo}:${x.agentId}:${x.role}`)
          .join(','),
      );

      // 至少有2种不同的配对结果
      const uniqueSignatures = new Set(signatures);
      expect(uniqueSignatures.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe('边界情况', () => {
    it('应该处理单人局', () => {
      const roles: RoleAssignment[] = [{ role: 'villager', faction: 'villager' }];
      const agentIds = ['agent-solo'];

      const result = assignRolesAndSeats(roles, agentIds);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        agentId: 'agent-solo',
        seatNo: 1,
        role: 'villager',
        faction: 'villager',
      });
    });

    it('应该处理大局（12人）', () => {
      const roles: RoleAssignment[] = Array.from({ length: 12 }, (_, i) => ({
        role: i < 4 ? 'werewolf' : 'villager',
        faction: i < 4 ? 'werewolf' : 'villager',
      }));
      const agentIds = Array.from({ length: 12 }, (_, i) => `agent-${i + 1}`);

      const result = assignRolesAndSeats(roles, agentIds);

      expect(result).toHaveLength(12);
      const seatNos = result.map((r) => r.seatNo);
      expect(Math.min(...seatNos)).toBe(1);
      expect(Math.max(...seatNos)).toBe(12);
    });
  });
});
