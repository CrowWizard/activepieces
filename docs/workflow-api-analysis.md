# Workflow 创建 API 分析：Activepieces vs n8n

## 1. Activepieces：操作驱动的渐进式创建

### 1.1 核心流程

Activepieces 的 workflow 创建是**分步操作**模式，不能一次性提交完整 workflow 图：

```
POST /v1/flows          → 创建空壳 flow（DISABLED + EMPTY trigger）
POST /v1/flows/:id      → 逐步应用操作（UPDATE_TRIGGER, ADD_ACTION, ...）
POST /v1/flows/:id      → LOCK_AND_PUBLISH 发布
```

### 1.2 创建空壳

**请求** `POST /v1/flows`

```json
{
  "displayName": "My Flow",
  "projectId": "proj_xxx",
  "folderId": "folder_xxx",       // 可选，优先于 folderName
  "folderName": "My Folder",      // 可选
  "templateId": "tmpl_xxx",      // 可选，从模板创建
  "metadata": {}                  // 可选
}
```

**返回**：flow 对象，包含 `id`、`status: DISABLED`、`publishedVersionId: null`。

**内部行为**：
- 创建 flow 记录（`DISABLED` 状态）
- 立即创建一个空的 draft version，trigger 为 `EMPTY` 类型
- 发出 `FLOW_CREATED` 事件

### 1.3 通过操作构建 workflow 内容

**请求** `POST /v1/flows/:id`

所有操作共用同一个 endpoint，通过 `type` 字段区分：

```json
{
  "type": "UPDATE_TRIGGER",
  "request": {
    "type": "PIECE_TRIGGER",
    "name": "trigger",
    "settings": {
      "pieceName": "@activepieces/piece-slack",
      "pieceVersion": "1.0.0",
      "triggerName": "new_message",
      "input": { "channel": "#general" }
    }
  }
}
```

```json
{
  "type": "ADD_ACTION",
  "request": {
    "action": {
      "type": "PIECE",
      "name": "step_1",
      "settings": {
        "pieceName": "@activepieces/piece-google-sheets",
        "pieceVersion": "1.0.0",
        "actionName": "append_row",
        "input": { "spreadsheetId": "xxx", "range": "A1:Z1" }
      }
    },
    "parentStep": "trigger"  // 挂在哪个 step 后面
  }
}
```

### 1.4 完整操作类型列表

| 操作 | 用途 |
|------|------|
| `UPDATE_TRIGGER` | 设置/修改触发器 |
| `ADD_ACTION` | 添加步骤 |
| `UPDATE_ACTION` | 修改步骤 |
| `DELETE_ACTION` | 删除步骤 |
| `DUPLICATE_ACTION` | 复制步骤 |
| `MOVE_ACTION` | 移动步骤位置 |
| `IMPORT_FLOW` | 导入完整 flow 结构 |
| `LOCK_FLOW` | 锁定 flow |
| `LOCK_AND_PUBLISH` | 锁定并发布 |
| `CHANGE_STATUS` | 启用/禁用 |
| `CHANGE_NAME` | 改名 |
| `CHANGE_FOLDER` | 移动文件夹 |
| `UPDATE_METADATA` | 更新元数据 |
| `ADD_BRANCH` / `DELETE_BRANCH` / `DUPLICATE_BRANCH` / `MOVE_BRANCH` | Router 分支操作 |
| `SET_SKIP_ACTION` | 跳过步骤 |
| `USE_AS_DRAFT` | 从已发布版本创建草稿 |

### 1.5 数据模型

**Flow 实体**：
- `projectId`, `ownerId`, `folderId`
- `status`: `ENABLED` / `DISABLED`
- `publishedVersionId` → 指向当前发布的版本
- `operationStatus`, `metadata`, `templateId`

**FlowVersion 实体**：
- `flowId`, `displayName`
- `trigger` (jsonb) → 递归图结构的根
- `schemaVersion` (当前最新 `'20'`)
- `connectionIds[]`, `agentIds[]`
- `valid`, `state` (`DRAFT` / `LOCKED`)
- `notes[]`

**Trigger 类型**：
- `EMPTY` → 占位，`valid: false`
- `PIECE_TRIGGER` → 真实触发器，含 `pieceName`, `pieceVersion`, `triggerName`, `input`

**Action 类型**：
- `CODE` → 自定义代码
- `PIECE` → 集成动作
- `LOOP_ON_ITEMS` → 循环，含 `firstLoopAction`
- `ROUTER` → 条件分支，含 `children[]`

**递归结构**：每个 action 都有 `nextAction`，形成链表；loop 有 `firstLoopAction`；router 有 `children`（分支数组）。

### 1.6 验证机制

- 操作应用时，`flowOperations.apply()` 会克隆整个版本，执行操作，然后遍历全图重算 `valid`
- `flowVersionValidatorUtil` 在操作预处理阶段：
  - 根据 piece 元数据校验 input
  - 规范化 `pieceVersion`
  - 清理 input 中非 schema 定义的字段
  - 设置每个 step 的 `valid` 标志

### 1.7 已知问题

- [Issue #8436](https://github.com/activepieces/activepieces/issues/8436)：通过 REST API 创建 flow 后，trigger 和 action 内容未被持久化，返回空 trigger
- `projectId` 在 body 和 query 中都可以传，来源不统一
- 递归结构依赖 `JSON.parse(JSON.stringify(...))` 深克隆

---

## 2. n8n：一次性图提交

### 2.1 核心流程

n8n 的 workflow 创建是**一次性提交完整图**：

```
POST /api/v1/workflows   → 创建完整 workflow（nodes + connections + settings）
```

### 2.2 创建请求

**请求** `POST /api/v1/workflows`

```json
{
  "name": "My Workflow",
  "nodes": [
    {
      "id": "uuid-1",
      "name": "Slack Trigger",
      "type": "n8n-nodes-base.slackTrigger",
      "typeVersion": 1,
      "position": [250, 300],
      "parameters": {
        "event": "message",
        "channel": "#general"
      },
      "credentials": {
        "slackApi": {
          "id": "cred_xxx",
          "name": "Slack account"
        }
      }
    },
    {
      "id": "uuid-2",
      "name": "Google Sheets",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 2,
      "position": [470, 300],
      "parameters": {
        "operation": "append",
        "documentId": "xxx",
        "range": "A1:Z1"
      }
    }
  ],
  "connections": {
    "Slack Trigger": {
      "main": [
        [
          { "node": "Google Sheets", "type": "main", "index": 0 }
        ]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1"
  },
  "projectId": "proj_xxx"  // 可选，默认个人项目
}
```

### 2.3 数据模型

**Node 结构**：
- `id` → 唯一标识
- `name` → 显示名
- `type` → 节点类型（如 `n8n-nodes-base.slackTrigger`）
- `typeVersion` → 节点版本号
- `position` → 画布坐标 `[x, y]`
- `parameters` → 节点参数，`additionalProperties: true`（开放 schema）
- `credentials` → 关联凭证

**Connections 结构**：
- 按 source node name 索引
- `main` → 主输出
- 每个输出是数组的数组（支持多输出、多目标）

**Settings**：
- `executionOrder`: `"v1"` 执行顺序模式

### 2.4 关键特性

- **一次性创建**：一个 POST 提交完整 workflow
- **开放参数**：`parameters` 允许任意字段（`additionalProperties: true`）
- **显式连接**：connections 独立于 nodes，明确声明数据流
- **画布坐标**：每个 node 有 `position`，UI 直接可用
- **凭证内联**：credentials 直接嵌入 node 定义

---

## 3. 对比分析

### 3.1 架构差异

| 维度 | Activepieces | n8n |
|------|-------------|-----|
| **创建模式** | 渐进式操作（shell → 操作 → 发布） | 一次性提交完整图 |
| **API 调用次数** | 创建 workflow 至少 3+ 次（创建 + 设 trigger + 加 action + 发布） | 1 次 |
| **图结构** | 递归链表（`nextAction` 嵌套） | 扁平节点 + 显式 connections |
| **触发器** | 特殊类型，图的根节点 | 普通 node，`type` 区分 |
| **分支/循环** | 内置类型 `ROUTER` / `LOOP_ON_ITEMS` | 通过 node 类型实现 |
| **版本管理** | Draft / Locked 版本，显式发布 | 无显式版本，直接 active/inactive |
| **凭证** | `connectionIds[]` 在 version 层面引用 | 嵌入每个 node |
| **验证** | 操作时实时校验 + piece 元数据校验 | 创建时 schema 校验 |
| **画布信息** | 无 position 字段 | 有 `position` 坐标 |

### 3.2 编程式创建体验

**n8n**：
```python
# 一次调用，完整 workflow
workflow = {
    "name": "Slack → Sheets",
    "nodes": [trigger_node, sheets_node],
    "connections": {...},
    "settings": {"executionOrder": "v1"}
}
resp = requests.post("/api/v1/workflows", json=workflow)
# 完成
```

**Activepieces**：
```python
# 1. 创建空壳
flow = requests.post("/v1/flows", json={"displayName": "Slack → Sheets", "projectId": "xxx"})

# 2. 设 trigger
requests.post(f"/v1/flows/{flow['id']}", json={
    "type": "UPDATE_TRIGGER",
    "request": { "type": "PIECE_TRIGGER", "settings": {...} }
})

# 3. 加 action
requests.post(f"/v1/flows/{flow['id']}", json={
    "type": "ADD_ACTION",
    "request": { "action": {...}, "parentStep": "trigger" }
})

# 4. 发布
requests.post(f"/v1/flows/{flow['id']}", json={"type": "LOCK_AND_PUBLISH"})
```

### 3.3 优劣分析

**Activepieces 的优势**：
- 操作原子性：每个操作独立校验，失败不影响已有结构
- 版本管理：Draft/Locked 机制天然支持回滚
- 运行时校验：基于 piece 元数据的 input 清洗，防止脏数据
- IMPORT_FLOW 操作：可以一次性导入完整结构（但需先构建完整 JSON）

**Activepieces 的劣势**：
- 编程式创建繁琐：需要多次 API 调用
- 已知 bug：REST 创建后内容可能丢失（#8436）
- 递归结构序列化/反序列化开销大
- `projectId` 来源不统一
- 缺少画布坐标，UI 重建时需要自动布局

**n8n 的优势**：
- 一次调用创建完整 workflow
- 开放参数 schema，灵活度高
- 扁平结构 + 显式 connections，序列化简单
- 画布坐标内嵌，UI 可直接渲染

**n8n 的劣势**：
- 无版本管理，无法回滚到上一个版本
- 无运行时校验，参数合法性依赖节点自身
- 大图一次性提交，部分失败需要整体重试
- connections 索引方式（按 node name）在重命名时脆弱

### 3.4 适用场景

| 场景 | 推荐 | 原因 |
|------|------|------|
| 外部系统批量生成 workflow | n8n | 一次调用，简单直接 |
| UI 交互式编辑 | Activepieces | 操作驱动，每步可校验可回滚 |
| 需要版本历史 | Activepieces | Draft/Locked 版本机制 |
| CI/CD 集成 | n8n | 声明式，易 diff 和版本控制 |
| 复杂分支/循环 | Activepieces | 内置 ROUTER/LOOP 类型 |
| 快速原型 | n8n | 低摩擦 |

---

## 4. Activepieces 编程式创建的可行路径

### 4.1 逐步操作法（当前 API）

最直接的方式，但调用次数多，且需注意 #8436 的 bug：

```python
# 1. 创建空壳
flow = POST /v1/flows  { displayName, projectId }

# 2. 设 trigger
POST /v1/flows/{id}  { type: UPDATE_TRIGGER, request: {...} }

# 3. 逐个加 action
POST /v1/flows/{id}  { type: ADD_ACTION, request: { action, parentStep } }

# 4. 发布
POST /v1/flows/{id}  { type: LOCK_AND_PUBLISH }
```

### 4.2 IMPORT_FLOW 法（推荐）

`IMPORT_FLOW` 操作可以一次性导入完整 flow 结构，减少 API 调用：

```python
# 1. 创建空壳
flow = POST /v1/flows  { displayName, projectId }

# 2. 一次性导入完整结构
POST /v1/flows/{id}  {
  type: IMPORT_FLOW,
  request: {
    trigger: { type: PIECE_TRIGGER, ... },
    steps: [...]  # 完整 action 链
  }
}

# 3. 发布
POST /v1/flows/{id}  { type: LOCK_AND_PUBLISH }
```

### 4.3 模板法

如果 workflow 模式固定，可以预建模板，从模板创建：

```python
# 从模板创建
flow = POST /v1/flows  { displayName, projectId, templateId: "tmpl_xxx" }
```

---

## 5. 改进建议

如果 Activepieces 要改善编程式创建体验，可考虑：

1. **新增 `POST /v1/flows/full` endpoint**：接受完整 workflow 图，一次性创建并发布
2. **修复 #8436**：确保操作内容被正确持久化
3. **统一 `projectId` 来源**：body 或 query，只保留一个
4. **添加画布坐标**：在 flow version 中支持 `position` 字段
5. **提供 SDK 封装**：将多步操作封装为高级 API

---

## 6. 关键源码路径

| 内容 | 路径 |
|------|------|
| Flow Controller | `packages/server/api/src/app/flows/flow/flow.controller.ts` |
| Flow Service | `packages/server/api/src/app/flows/flow/flow.service.ts` |
| Flow Entity | `packages/server/api/src/app/flows/flow/flow.entity.ts` |
| FlowVersion Entity | `packages/server/api/src/app/flows/flow-version/flow-version-entity.ts` |
| FlowVersion Service | `packages/server/api/src/app/flows/flow-version/flow-version.service.ts` |
| CreateFlowRequest DTO | `packages/shared/src/lib/automation/flows/dto/create-flow-request.ts` |
| Flow Operations | `packages/shared/src/lib/automation/flows/operations/index.ts` |
| Trigger Types | `packages/shared/src/lib/automation/flows/triggers/trigger.ts` |
| Action Types | `packages/shared/src/lib/automation/flows/actions/action.ts` |
| Flow Structure Util | `packages/shared/src/lib/automation/flows/util/flow-structure-util.ts` |
| Flow Version Validator | `packages/server/api/src/app/flows/flow-version/flow-version-validator-util.ts` |
| Flow Version Migration | `packages/server/api/src/app/flows/flow-version/flow-version-migration.service.ts` |
| OpenAPI Spec | `docs/openapi.json` |
| Integration Tests | `packages/server/api/test/integration/ce/flows/flow/flow.test.ts` |

---

## 7. 参考

- n8n workflow create schema: https://github.com/n8n-io/n8n/blob/master/packages/cli/src/public-api/v1/handlers/workflows/spec/schemas/workflowCreate.yml
- n8n node schema: https://github.com/n8n-io/n8n/blob/master/packages/cli/src/public-api/v1/handlers/workflows/spec/schemas/node.yml
- Activepieces #8436 (flow content not persisted via REST): https://github.com/activepieces/activepieces/issues/8436
- Activepieces PR #7468 (metadata in flow operation): https://github.com/activepieces/activepieces/pull/7468
- Activepieces PR #7482 (UPDATE_METADATA operation): https://github.com/activepieces/activepieces/pull/7482
