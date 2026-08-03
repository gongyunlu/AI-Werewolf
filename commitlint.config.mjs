export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        // ========== 第一类：对用户/业务有影响（必须写进 Changelog） ==========
        'feat', // 新增功能（用户可感知的新特性）
        'fix', // 修复 Bug（用户可感知的问题修复）
        'perf', // 性能优化（提升响应速度、减少资源消耗等）

        // ========== 第二类：对开发者/维护有影响（按需使用） ==========
        'refactor', // 代码重构（不改变功能，只优化代码结构）
        'style', // 代码格式（只改空格、缩进、分号，不改变逻辑）
        'test', // 测试相关（增删改单元测试或 E2E 测试）
        'docs', // 文档变更（只改 README、注释或 API 文档）
        'build', // 构建工具/依赖变更（Webpack/Vite 配置、package.json 依赖）
        'ci', // CI 配置变更（GitHub Actions、Jenkins、GitLab CI 等）
        'chore', // 其他（不修改业务代码的变更，例如构建流程、辅助工具、配置文件的变动）

        // ========== 第三类：特殊情况 ==========
        'revert', // 回滚之前的提交（格式：revert: feat: 增加登录功能）
      ],
    ],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
