## Step 编排器 — Router/Loop 决策模型

### Router
- `RouterAction.children: (FlowAction | null)[]` — 每个元素对应一个 branch
- Router step output: `{ branches: [{ branchName, branchIndex, evaluation }] }`
- `evaluation: true` 表示该 branch 应该执行
- `RouterExecutionType.EXECUTE_FIRST_MATCH` — 只执行第一个匹配的 branch
- `RouterExecutionType.EXECUTE_ALL_MATCH` — 执行所有匹配的 branch
- 每个 branch 的第一个 step 是 `action.children[i]`（可能为 null）

### Loop
- `LoopOnItemsAction.firstLoopAction?: FlowAction` — 循环体第一个 step
- `LoopOnItemsAction.nextAction?: FlowAction` — 循环之后的 step
- Loop step output: `{ item, index, iterations: Record<string, StepOutput>[] }`
- `iterations.length` = 已完成的迭代次数
- Loop 编排策略：Loop 整体作为一个编排单位，不拆分每次迭代为独立 Job（与计划一致）

### 设计决策
- Router/Loop step 本身由 Worker 执行（包含条件评估逻辑），编排者只负责根据 output 决定下一步
- 编排者读取已完成的 Router output 的 branches 信息确定需要入队的 branch 首步
- 编排者读取已完成的 Loop output 的 iterations 信息确定是否需要继续迭代
