# CLAUDE.md

## karpathy-guidelines skill 调用规则

本项目在 `.claude/skills/karpathy-guidelines/SKILL.md` 安装了项目级 skill（来自 [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)）。SKILL.md 是唯一规则来源，本文件只负责说明何时调用它。

**何时调用**：以下工作开始前，用 Skill 工具加载 `karpathy-guidelines` 并遵循其规则：

- 编写新代码
- 审查、重构或修改现有代码
- 对已有改动做验收或 code review

**可不调用**：琐碎任务（如改一个变量名、纯文档/配置改动、只读任务）。规则偏向「谨慎」而非「速度」，琐碎时自行判断。

**注意事项**：

- 调用后以 SKILL.md 内容为准，本文件不重复其内容
- 如果规则与实际需求冲突（如用户明确要求快速出活），用户指令优先，但应指出冲突
