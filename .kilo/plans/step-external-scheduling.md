# Plan: Step 执行外部调度支持（Inngest / Hatchet）

## 项目类型判断

- **类型**：已有项目（Activepieces）— 架构扩展
- **目标**：新增外部 step 执行 API + 外部调度模式开关，使 Inngest / Hatchet 等外部调度器可以通过 HTTP API 调用 AP 执行单个 step
- **核心约束**：AP 只负责 step 执行和结果存储，不自动编排下一个 step

## Discovery 结果摘要

### 现有基础设施（已实现）

1. **`flow_run_step` 表**：已存在，存储每个 step 的 output/input/status/duration 等
2. **`flowRunStepService`**：已存在，提供 `save` / `getStepOutputs` / `getStepOutput` / `deleteByFlowRunId`
3. **`WorkerJobType.EXECUTE_STEP`**：已存在，Worker 已能独立执行单个 step
4. **`executeStepJob`**：已存在，Worker handler 已实现
5. **`stepOrchestrator`**：已存在，API 端 step 编排器
6. **`stepLevelSchedulingFlag`**：已存在，EE feature flag
7. **`job-broker.ts`**：已存在，step 完成后调用 `stepOrchestrator.onStepCompleted`

### 需要新增的部分

1. **外部 step 执行 API**：`POST /v1/step-runs/execute` — 异步入队 step 执行，返回 `stepRunId`
2. **外部 step 结果查询 API**：`GET /v1/step-runs/:id` — 查询 step 执行结果
3. **外部调度模式开关**：在 `stepOrchestrator.onStepCompleted` 中跳过自动编排
4. **Flow Run 创建 API 扩展**：支持外部调度模式下创建 flow run

---

## 实施阶段

### Phase 1: Shared 类型定义

**目标**：在 `@activepieces/shared` 中新增外部 step 执行相关的类型。

#### 1.1 新增 `SchedulingMode` 枚举

```typescript
// packages/shared/src/lib/automation/flows/step-run/index.ts
export const SchedulingMode = z.enum(['INTERNAL', 'EXTERNAL'])
export type SchedulingMode = z.infer<typeof SchedulingMode>
```

#### 1.2 新增 `ExecuteStepRunRequest` / `ExecuteStepRunResponse` / `GetStepRunResponse`

```typescript
export const ExecuteStepRunRequest = z.object({
  flowRunId: ApIdSchema,
  flowVersionId: ApIdSchema,
  stepName: z.string(),
  projectId: ApIdSchema,
  executionType: z.nativeEnum(ExecutionType).default(ExecutionType.BEGIN),
  resumePayload: z.unknown().optional(),
  resumeReason: z.nativeEnum(ResumeReason).optional(),
})

export const ExecuteStepRunResponse = z.object({
  stepRunId: ApIdSchema,
  flowRunId: ApIdSchema,
  stepName: z.string(),
  status: z.nativeEnum(StepOutputStatus),
})

export const GetStepRunResponse = z.object({
  id: ApIdSchema,
  flowRunId: ApIdSchema,
  stepName: z.string(),
  stepType: z.nativeEnum(FlowRunStepType),
  status: z.nativeEnum(StepOutputStatus),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  duration: z.number().nullable(),
  errorMessage: z.unknown().nullable(),
  queuedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  retryCount: z.number(),
})
```

#### 1.3 扩展 `ExecuteStepJobData` — 增加 `skipOrchestration`

在 `ExecuteStepJobData` schema 中新增：
```typescript
skipOrchestration: z.boolean().default(false),
```

#### 1.4 扩展 FlowRun — 增加 `schedulingMode` 字段

在 FlowRun 相关类型中新增 `schedulingMode: SchedulingMode`，默认 `'INTERNAL'`。

---

### Phase 2: 数据库 Migration

**目标**：`flow_run` 表新增 `schedulingMode` 列。

#### 2.1 新增 migration

```sql
ALTER TABLE "flow_run" ADD "schedulingMode" VARCHAR(20) NOT NULL DEFAULT 'INTERNAL';
```

#### 2.2 更新 FlowRunEntity

在 `flow-run-entity.ts` 中新增 `schedulingMode` 列定义。

---

### Phase 3: API 端点

**目标**：新增 step 执行 API 和结果查询 API。

#### 3.1 新增 `step-run.controller.ts`

```
POST /v1/step-runs/execute  → 异步入队 step 执行，返回 { stepRunId, status }
GET  /v1/step-runs/:id      → 查询 step 执行结果
```

**execute 端点逻辑**：
1. 验证 flowRun 存在且 `schedulingMode = EXTERNAL`
2. 创建/更新 `flow_run_step` 记录 (`status=RUNNING`, `queuedAt=now`)
3. 入队 `EXECUTE_STEP` Job (`skipOrchestration=true`)
4. 返回 `{ stepRunId, flowRunId, stepName, status: RUNNING }`

**get 端点逻辑**：
1. 查询 `flow_run_step` 记录
2. 返回完整 step 执行结果

#### 3.2 安全配置

两个端点都需要 `securityAccess.project([PrincipalType.USER, PrincipalType.SERVICE])` 权限。

#### 3.3 注册路由

在 `flow.module.ts` 中：
```typescript
await app.register(stepRunController, { prefix: '/v1/step-runs' })
```

---

### Phase 4: 外部调度模式开关

**目标**：当 flow run 的 `schedulingMode = EXTERNAL` 时，step 完成后不自动编排下一个 step。

#### 4.1 修改 `job-broker.ts`

在 `completeJob` 中，`EXECUTE_STEP` 完成后：

```typescript
if (jobData.jobType === WorkerJobType.EXECUTE_STEP) {
    const stepJobData = jobData as ExecuteStepJobData
    const stepResponse = input.response as StepOutput | undefined

    // 无论哪种模式，都保存 step output
    if (!isNil(stepResponse)) {
        await flowRunStepService(log).save({
            flowRunId: stepJobData.flowRunId,
            projectId: stepJobData.projectId,
            stepName: stepJobData.stepName,
            stepType: toFlowRunStepType(stepResponse.type),
            status: stepResponse.status,
            input: stepResponse.input,
            output: stepResponse.output,
            duration: stepResponse.duration,
            errorMessage: stepResponse.errorMessage,
            finishedAt: new Date().toISOString(),
        })
    }

    // 外部调度模式：只保存结果，不编排下一个 step
    if (stepJobData.skipOrchestration) {
        log.info({ flowRunId: stepJobData.flowRunId, stepName: stepJobData.stepName },
            '[jobBroker] External scheduling — skipping orchestrator')
        return
    }

    // 内部调度模式：走现有 stepOrchestrator
    await stepOrchestrator(log).onStepCompleted({ ... })
}
```

#### 4.2 FlowRunService 扩展

在 `start()` 参数中增加 `schedulingMode`，当为 `'EXTERNAL'` 时：
- 创建 flow run 记录时保存 `schedulingMode`
- 不自动触发 trigger step
- 等待外部调度器通过 API 逐个调用 step

---

### Phase 5: Flow Run 生命周期管理

**目标**：外部调度模式下，flow run 的状态由外部调度器管理。

#### 5.1 新增 API：更新 flow run 状态

```
POST /v1/flow-runs/:id/complete
{
  status: 'SUCCEEDED' | 'FAILED',
  failedStep?: { name: string, displayName: string, message: string }
}
```

外部调度器在所有 step 执行完成后，调用此 API 标记 flow run 完成。

#### 5.2 外部调度器使用流程文档

外部调度器需要：
1. 解析 flowVersion.trigger → action 链获取 step 结构
2. 按 step 顺序逐个调用 `POST /v1/step-runs/execute`
3. 轮询 `GET /v1/step-runs/:id` 获取结果
4. 根据 step 结果（Router 分支、Loop 迭代）决定下一步
5. 所有 step 完成后调用 `POST /v1/flow-runs/:id/complete`

---

## 实施顺序与依赖关系

```
Phase 1 (Shared 类型) ──┐
                         ├──▶ Phase 3 (API 端点) ──▶ Phase 4 (外部调度开关) ──▶ Phase 5 (生命周期)
Phase 2 (DB Migration) ──┘
```

- Phase 1 + 2 可并行，不影响现有功能
- Phase 3 依赖 Phase 1 + 2 的类型和 migration
- Phase 4 依赖 Phase 3 的 API
- Phase 5 依赖 Phase 4 的外部调度模式
- 最小可行路径：Phase 1 → Phase 2 → Phase 3 → Phase 4

## 风险与缓解

| 风险 | 严重度 | 缓解措施 |
|------|--------|---------|
| 外部调度器与 AP step 状态不一致 | 高 | step 结果先持久化到 flow_run_step，外部调度器从 DB 读取 |
| 外部调度器 crash 导致 flow run 悬挂 | 高 | 增加超时机制，flow run 长时间无 step 请求自动标记 TIMED_OUT |
| Router/Loop 编排逻辑在外部实现复杂 | 中 | 首版只支持线性 step 编排，Router/Loop 后续增强 |
| flow_run_step output 过大 | 中 | 复用现有 LogSliceRef 机制 |
| skipOrchestration 标志在 job 重试时丢失 | 中 | BullMQ job data 是持久的，不会丢失 |

## 起手结论

- 项目类型：已有项目，架构扩展
- 核心参照：现有 stepOrchestrator + stepLevelSchedulingFlag
- 最小可行路径：Phase 1 → Phase 2 → Phase 3 → Phase 4
- 推荐入口：从 Phase 1 (Shared 类型) + Phase 2 (Migration) 并行开始
- 最大风险：job-broker 中 skipOrchestration 逻辑的正确性 + 外部调度器 crash 的恢复
