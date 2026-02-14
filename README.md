# AutoForge - PRD → Production Code Automation

OpenClaw 插件：从 PRD（产品需求文档）自动生成生产级代码。

## 功能

- **forge_init** - 从 PRD 初始化项目
- **forge_plan** - 规划架构
- **forge_next** - 获取下一个待实现功能（依赖感知）
- **forge_claim** - 认领功能进行实现
- **forge_done** - 标记功能完成
- **forge_status** - 查看项目进度
- **forge_run** - 完整自动化流程
- **forge_review** - 代码审查
- **forge_push** - 推送到 GitHub

## 安装

```bash
# 方法 1: 从本地路径安装
openclaw plugins install /path/to/autoforge

# 方法 2: 从 GitHub 安装
openclaw plugins install https://github.com/YOUR_USERNAME/autoforge/archive/refs/heads/main.zip
```

## 配置

在 `openclaw.json` 中启用：

```json
{
  "plugins": {
    "allow": ["autoforge"],
    "entries": {
      "autoforge": { "enabled": true }
    }
  }
}
```

## 使用示例

### 1. 创建 PRD 文件

```markdown
# My Project

## 功能需求

### Feature 1: 用户认证

- **描述**: 实现用户登录注册
- **优先级**: P0
- **依赖**: 无

### Feature 2: 数据存储

- **描述**: 数据持久化
- **优先级**: P1
- **依赖**: feat-001
```

### 2. 初始化项目

```bash
# 在 OpenClaw 中调用
forge_init(prd="/path/to/prd.md")
```

### 3. 查看进度

```bash
forge_status(projectId="proj-xxx")
```

### 4. 获取下一个功能

```bash
forge_next(projectId="proj-xxx")
```

## 依赖

- SQLite3（自动安装）
- GitHub CLI（可选，用于 forge_push）

## 模型配置

支持自定义模型：

```javascript
forge_init({
  prd: "/path/to/prd.md",
  options: {
    architectModel: "anthropic-newcli/claude-opus-4-6-20250528",
    coderModel: "zhipuai/glm-5",
    reviewerModel: "anthropic-newcli/claude-opus-4-6-20250528",
    maxParallel: 3,
  },
});
```

## License

MIT
