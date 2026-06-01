import {
    ExecuteStepJobData,
    ExecutionType,
    FlowActionType,
    FlowRunStatus,
    FlowRunStep,
    FlowRunStepType,
    flowStructureUtil,
    FlowVersion,
    isFlowRunStateTerminal,
    isNil,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    LoopOnItemsAction,
    LoopStepResult,
    ResumeReason,
    RouterAction,
    RouterExecutionType,
    RunEnvironment,
    StepOutput,
    StepOutputStatus,
    StreamStepProgress,
    tryCatch,
    WorkerJobType,
} from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { distributedLock } from '../../database/redis-connections'
import { workerGroupService } from '../../ee/platform/platform-plan/worker-group.service'
import { getWorkerGroupQueueName, QueueName, RunsMetadataUpsertData } from '../../workers/job'
import { jobQueue, JobType } from '../../workers/job-queue/job-queue'
import { flowVersionService } from '../flow-version/flow-version.service'
import { flowRunRepo } from './flow-run-service'
import { flowRunStepRepo } from './flow-run-step-repo'
import { flowRunStepService } from './flow-run-step-service'
import { runsMetadataQueue } from './flow-runs-queue'

const MAX_STEP_RETRY_ATTEMPTS = 4
const STEP_RETRY_BASE_INTERVAL_MS = 2000
const STEP_RETRY_EXPONENTIAL = 2
const STEP_RETRY_MAX_BACKOFF_MS = 60_000
const ORCHESTRATOR_LOCK_TIMEOUT_SECONDS = 30
const MAX_PARALLEL_STEPS_PER_FLOW_RUN = 10

type NextStepResult = {
    nextStepNames: string[]
    isTerminal: boolean
}

type OnStepCompletedParams = {
    flowRunId: string
    projectId: string
    platformId: string
    stepName: string
    stepType: FlowRunStepType
    stepOutput: StepOutput
    flowVersionId: string
    environment: RunEnvironment
    logsFileId: string
    workerHandlerId?: string | null
    httpRequestId?: string
    streamStepProgress: StreamStepProgress
    stepNameToTest?: string
    traceContext?: Record<string, string>
    queueName?: string
}

export const stepOrchestrator = (log: FastifyBaseLogger) => ({
    async onStepCompleted(params: OnStepCompletedParams): Promise<void> {
        await distributedLock(log).runExclusive({
            key: `step-orchestrator:${params.flowRunId}`,
            timeoutInSeconds: ORCHESTRATOR_LOCK_TIMEOUT_SECONDS,
            fn: async () => onStepCompletedInner(log, params),
        })
    },

    async cancelPendingSteps(params: {
        flowRunId: string
        projectId: string
        platformId: string | null
    }): Promise<void> {
        await distributedLock(log).runExclusive({
            key: `step-orchestrator:${params.flowRunId}`,
            timeoutInSeconds: ORCHESTRATOR_LOCK_TIMEOUT_SECONDS,
            fn: async () => cancelPendingStepsInner(log, params),
        })
    },

    async enqueueFirstStep(params: {
        flowRunId: string
        projectId: string
        platformId: string
        flowVersionId: string
        triggerStepName: string
        environment: RunEnvironment
        logsFileId: string
        workerHandlerId?: string | null
        httpRequestId?: string
        streamStepProgress: StreamStepProgress
        stepNameToTest?: string
        traceContext?: Record<string, string>
    }): Promise<void> {
        const { flowRunId, projectId, platformId, flowVersionId } = params

        const flowVersion = await flowVersionService(log).getOne(flowVersionId)
        if (isNil(flowVersion)) {
            log.error({ flowVersionId }, '[stepOrchestrator#enqueueFirstStep] Flow version not found')
            return
        }

        const trigger = flowStructureUtil.getTriggerOrThrow((flowVersion as unknown as FlowVersion).trigger)
        const firstAction = trigger.nextAction

        if (isNil(firstAction)) {
            await updateFlowRunStatus(log, {
                flowRunId,
                projectId,
                status: FlowRunStatus.SUCCEEDED,
                finishTime: new Date().toISOString(),
            })
            log.info({ flowRunId }, '[stepOrchestrator#enqueueFirstStep] No actions after trigger — flow run completed')
            return
        }

        const typedFlowVersion = flowVersion as unknown as FlowVersion

        const targetQueue = await resolveTargetQueue({
            stepName: firstAction.name,
            flowVersion: typedFlowVersion,
            platformId,
            log,
        })

        const stepJobData: ExecuteStepJobData = {
            schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
            jobType: WorkerJobType.EXECUTE_STEP,
            flowRunId,
            flowVersionId,
            stepName: firstAction.name,
            executionType: ExecutionType.BEGIN,
            platformId,
            projectId,
            environment: params.environment,
            logsFileId: params.logsFileId,
            workerHandlerId: params.workerHandlerId ?? null,
            httpRequestId: params.httpRequestId,
            streamStepProgress: params.streamStepProgress,
            stepNameToTest: params.stepNameToTest,
            traceContext: params.traceContext,
            stepTimeoutSeconds: resolveStepTimeoutSeconds(firstAction.name, typedFlowVersion),
        }

        await jobQueue(log).add({
            id: `${flowRunId}-${firstAction.name}`,
            type: JobType.ONE_TIME,
            data: stepJobData,
            queueName: targetQueue,
        })

        await flowRunStepService(log).save({
            flowRunId,
            projectId,
            stepName: firstAction.name,
            stepType: FlowRunStepType.PIECE,
            status: StepOutputStatus.RUNNING,
            queuedAt: new Date().toISOString(),
            queueName: targetQueue,
        })

        await updateFlowRunStatus(log, {
            flowRunId,
            projectId,
            status: FlowRunStatus.STEP_QUEUED,
        })

        log.info({ flowRunId, firstStepName: firstAction.name, targetQueue }, '[stepOrchestrator#enqueueFirstStep] First step enqueued')
    },

    async enqueueStepResume(params: {
        flowRunId: string
        projectId: string
        platformId: string
        flowVersionId: string
        stepName: string
        resumePayload: unknown
        resumeReason: ResumeReason
        environment: RunEnvironment
        logsFileId: string
        workerHandlerId?: string | null
        httpRequestId?: string
        streamStepProgress: StreamStepProgress
        stepNameToTest?: string
        traceContext?: Record<string, string>
    }): Promise<void> {
        const { flowRunId, projectId, platformId, flowVersionId, stepName } = params

        const flowVersion = await flowVersionService(log).getOne(flowVersionId)
        if (isNil(flowVersion)) {
            log.error({ flowVersionId }, '[stepOrchestrator#enqueueStepResume] Flow version not found')
            return
        }

        const typedFlowVersion = flowVersion as unknown as FlowVersion

        const targetQueue = await resolveTargetQueue({
            stepName,
            flowVersion: typedFlowVersion,
            platformId,
            log,
        })

        const stepJobData: ExecuteStepJobData = {
            schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
            jobType: WorkerJobType.EXECUTE_STEP,
            flowRunId,
            flowVersionId,
            stepName,
            executionType: ExecutionType.RESUME,
            resumePayload: params.resumePayload,
            resumeReason: params.resumeReason,
            platformId,
            projectId,
            environment: params.environment,
            logsFileId: params.logsFileId,
            workerHandlerId: params.workerHandlerId ?? null,
            httpRequestId: params.httpRequestId,
            streamStepProgress: params.streamStepProgress,
            stepNameToTest: params.stepNameToTest,
            traceContext: params.traceContext,
            stepTimeoutSeconds: resolveStepTimeoutSeconds(stepName, typedFlowVersion),
        }

        await jobQueue(log).add({
            id: `${flowRunId}-${stepName}-resume`,
            type: JobType.ONE_TIME,
            data: stepJobData,
            queueName: targetQueue,
        })

        await flowRunStepService(log).save({
            flowRunId,
            projectId,
            stepName,
            stepType: FlowRunStepType.PIECE,
            status: StepOutputStatus.RUNNING,
            queuedAt: new Date().toISOString(),
            queueName: targetQueue,
        })

        await updateFlowRunStatus(log, {
            flowRunId,
            projectId,
            status: FlowRunStatus.STEP_QUEUED,
        })

        log.info({ flowRunId, stepName, resumeReason: params.resumeReason, targetQueue }, '[stepOrchestrator#enqueueStepResume] Step resume enqueued')
    },
})

async function onStepCompletedInner(log: FastifyBaseLogger, params: OnStepCompletedParams): Promise<void> {
    const { flowRunId, projectId, stepName, stepOutput, flowVersionId } = params

    const flowRun = await flowRunRepo().findOneBy({ id: flowRunId, projectId })
    if (isNil(flowRun) || isFlowRunStateTerminal({ status: flowRun.status, ignoreInternalError: false })) {
        log.info({ flowRunId, stepName, flowRunStatus: flowRun?.status }, '[stepOrchestrator#onStepCompleted] Flow run is terminal or not found — skipping')
        return
    }

    const currentRetryCount = await flowRunStepRepo().findOneBy({
        flowRunId: params.flowRunId,
        stepName: params.stepName,
        projectId: params.projectId,
    }).then((step: FlowRunStep | null) => step?.retryCount ?? 0)

    await flowRunStepService(log).save({
        flowRunId,
        projectId,
        stepName,
        stepType: params.stepType,
        status: stepOutput.status,
        input: stepOutput.input,
        output: stepOutput.output,
        duration: stepOutput.duration,
        errorMessage: stepOutput.errorMessage,
        queueName: params.queueName,
        finishedAt: new Date().toISOString(),
        retryCount: currentRetryCount,
    })

    log.info({ flowRunId, stepName, status: stepOutput.status }, '[stepOrchestrator#onStepCompleted] Step output saved')

    if (stepOutput.status === StepOutputStatus.FAILED) {
        if (currentRetryCount < MAX_STEP_RETRY_ATTEMPTS) {
            const nextRetryCount = currentRetryCount + 1
            const backoffMs = Math.min(Math.pow(STEP_RETRY_EXPONENTIAL, currentRetryCount) * STEP_RETRY_BASE_INTERVAL_MS, STEP_RETRY_MAX_BACKOFF_MS)
            log.info({ flowRunId, stepName, currentRetryCount, nextRetryCount, backoffMs }, '[stepOrchestrator#onStepCompleted] Step failed — retrying with backoff')

            const flowVersion = await flowVersionService(log).getOne(flowVersionId)
            if (isNil(flowVersion)) {
                log.error({ flowVersionId }, '[stepOrchestrator#onStepCompleted] Flow version not found for retry')
                await markFlowRunFailed(log, flowRunId, projectId, stepName, stepOutput)
                return
            }

            const typedFlowVersion = flowVersion as unknown as FlowVersion
            const targetQueue = await resolveTargetQueue({
                stepName,
                flowVersion: typedFlowVersion,
                platformId: params.platformId,
                log,
            })

            const stepJobData: ExecuteStepJobData = {
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                jobType: WorkerJobType.EXECUTE_STEP,
                flowRunId,
                flowVersionId,
                stepName,
                executionType: ExecutionType.BEGIN,
                platformId: params.platformId,
                projectId,
                environment: params.environment,
                logsFileId: params.logsFileId,
                workerHandlerId: params.workerHandlerId ?? null,
                httpRequestId: params.httpRequestId,
                streamStepProgress: params.streamStepProgress,
                stepNameToTest: params.stepNameToTest,
                traceContext: params.traceContext,
                stepTimeoutSeconds: resolveStepTimeoutSeconds(stepName, typedFlowVersion),
            }

            await jobQueue(log).add({
                id: `${flowRunId}-${stepName}-retry-${nextRetryCount}`,
                type: JobType.ONE_TIME,
                data: stepJobData,
                queueName: targetQueue,
                delay: backoffMs,
            })

            await flowRunStepService(log).save({
                flowRunId,
                projectId,
                stepName,
                stepType: params.stepType,
                status: StepOutputStatus.RUNNING,
                queuedAt: new Date().toISOString(),
                queueName: targetQueue,
                retryCount: nextRetryCount,
            })

            await updateFlowRunStatus(log, {
                flowRunId,
                projectId,
                status: FlowRunStatus.STEP_QUEUED,
            })

            return
        }

        await markFlowRunFailed(log, flowRunId, projectId, stepName, stepOutput)
        log.info({ flowRunId, stepName, currentRetryCount }, '[stepOrchestrator#onStepCompleted] Step failed after max retries — Flow run marked as FAILED')
        return
    }

    if (stepOutput.status === StepOutputStatus.PAUSED) {
        await updateFlowRunStatus(log, {
            flowRunId,
            projectId,
            status: FlowRunStatus.PAUSED,
        })
        log.info({ flowRunId, stepName }, '[stepOrchestrator#onStepCompleted] Flow run marked as PAUSED')
        return
    }

    const flowVersion = await flowVersionService(log).getOne(flowVersionId)
    if (isNil(flowVersion)) {
        log.error({ flowVersionId }, '[stepOrchestrator#onStepCompleted] Flow version not found')
        return
    }

    const typedFlowVersion = flowVersion as unknown as FlowVersion
    const nextStep = resolveNextStep({
        flowVersion: typedFlowVersion,
        completedStepName: stepName,
        stepOutput,
    })

    if (nextStep.isTerminal || nextStep.nextStepNames.length === 0) {
        await updateFlowRunStatus(log, {
            flowRunId,
            projectId,
            status: FlowRunStatus.SUCCEEDED,
            finishTime: new Date().toISOString(),
        })
        log.info({ flowRunId }, '[stepOrchestrator#onStepCompleted] Flow run completed — no more steps')
        return
    }

    const stepsToEnqueue = nextStep.nextStepNames.slice(0, MAX_PARALLEL_STEPS_PER_FLOW_RUN)
    if (nextStep.nextStepNames.length > MAX_PARALLEL_STEPS_PER_FLOW_RUN) {
        log.warn({
            flowRunId,
            requestedParallelSteps: nextStep.nextStepNames.length,
            maxParallelSteps: MAX_PARALLEL_STEPS_PER_FLOW_RUN,
        }, '[stepOrchestrator#onStepCompleted] Parallel step count exceeds limit — truncating')
    }

    for (const nextStepName of stepsToEnqueue) {
        const targetQueue = await resolveTargetQueue({
            stepName: nextStepName,
            flowVersion: typedFlowVersion,
            platformId: params.platformId,
            log,
        })

        const stepJobData: ExecuteStepJobData = {
            schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
            jobType: WorkerJobType.EXECUTE_STEP,
            flowRunId,
            flowVersionId,
            stepName: nextStepName,
            executionType: ExecutionType.BEGIN,
            platformId: params.platformId,
            projectId,
            environment: params.environment,
            logsFileId: params.logsFileId,
            workerHandlerId: params.workerHandlerId ?? null,
            httpRequestId: params.httpRequestId,
            streamStepProgress: params.streamStepProgress,
            stepNameToTest: params.stepNameToTest,
            traceContext: params.traceContext,
            stepTimeoutSeconds: resolveStepTimeoutSeconds(nextStepName, typedFlowVersion),
        }

        await jobQueue(log).add({
            id: `${flowRunId}-${nextStepName}`,
            type: JobType.ONE_TIME,
            data: stepJobData,
            queueName: targetQueue,
        })

        await flowRunStepService(log).save({
            flowRunId,
            projectId,
            stepName: nextStepName,
            stepType: FlowRunStepType.PIECE,
            status: StepOutputStatus.RUNNING,
            queuedAt: new Date().toISOString(),
            queueName: targetQueue,
        })
    }

    await updateFlowRunStatus(log, {
        flowRunId,
        projectId,
        status: FlowRunStatus.STEP_QUEUED,
    })

    log.info({ flowRunId, nextStepNames: stepsToEnqueue }, '[stepOrchestrator#onStepCompleted] Next step(s) enqueued')
}

async function cancelPendingStepsInner(log: FastifyBaseLogger, params: {
    flowRunId: string
    projectId: string
    platformId: string | null
}): Promise<void> {
    const { flowRunId, projectId, platformId } = params

    const pendingSteps = await flowRunStepRepo().findBy({
        flowRunId,
        projectId,
        status: StepOutputStatus.RUNNING,
    })

    if (pendingSteps.length === 0) {
        log.info({ flowRunId }, '[stepOrchestrator#cancelPendingSteps] No pending steps found')
        return
    }

    for (const step of pendingSteps) {
        const retrySuffix = step.retryCount > 0 ? `-retry-${step.retryCount}` : ''
        const jobId = `${flowRunId}-${step.stepName}${retrySuffix}`

        const { error } = await tryCatch(() => jobQueue(log).removeOneTimeJob({ jobId, platformId }))
        if (!isNil(error)) {
            log.warn({ flowRunId, stepName: step.stepName, jobId, error: String(error) }, '[stepOrchestrator#cancelPendingSteps] Failed to remove step job from queue')
        }

        await flowRunStepService(log).save({
            flowRunId,
            projectId,
            stepName: step.stepName,
            stepType: step.stepType,
            status: StepOutputStatus.STOPPED,
            finishedAt: new Date().toISOString(),
        })
    }

    log.info({ flowRunId, cancelledStepCount: pendingSteps.length, cancelledSteps: pendingSteps.map((s: FlowRunStep) => s.stepName) }, '[stepOrchestrator#cancelPendingSteps] Pending steps cancelled')
}

async function updateFlowRunStatus(log: FastifyBaseLogger, params: {
    flowRunId: string
    projectId: string
    status: FlowRunStatus
    failedStep?: { name: string, displayName: string, message?: string }
    finishTime?: string
}): Promise<void> {
    const metadata: RunsMetadataUpsertData = {
        id: params.flowRunId,
        projectId: params.projectId,
        status: params.status,
        failedStep: params.failedStep,
        finishTime: params.finishTime,
    }
    await runsMetadataQueue(log).add(metadata)
}

async function markFlowRunFailed(log: FastifyBaseLogger, flowRunId: string, projectId: string, stepName: string, stepOutput: StepOutput): Promise<void> {
    const safeMessage = typeof stepOutput.errorMessage === 'string'
        ? stepOutput.errorMessage
        : (stepOutput.errorMessage as Record<string, unknown> | null)?.message?.toString() ?? 'Step execution failed'
    await updateFlowRunStatus(log, {
        flowRunId,
        projectId,
        status: FlowRunStatus.FAILED,
        failedStep: {
            name: stepName,
            displayName: stepName,
            message: safeMessage,
        },
        finishTime: new Date().toISOString(),
    })
}

function resolveNextStep(params: {
    flowVersion: FlowVersion
    completedStepName: string
    stepOutput: StepOutput
}): NextStepResult {
    const { flowVersion, completedStepName, stepOutput } = params

    try {
        const completedStep = flowStructureUtil.getActionOrThrow(completedStepName, flowVersion.trigger)

        if (completedStep.type === FlowActionType.ROUTER) {
            return resolveRouterNextStep(completedStep as RouterAction, stepOutput)
        }

        if (completedStep.type === FlowActionType.LOOP_ON_ITEMS) {
            return resolveLoopNextStep(completedStep as LoopOnItemsAction, stepOutput)
        }

        const insideResult = findNextStepInsideContainer(flowVersion, completedStepName)
        if (!isNil(insideResult)) {
            return insideResult
        }

        const nextAction = completedStep.nextAction
        if (isNil(nextAction)) {
            return { nextStepNames: [], isTerminal: true }
        }

        return { nextStepNames: [nextAction.name], isTerminal: false }
    }
    catch {
        return { nextStepNames: [], isTerminal: true }
    }
}

function resolveRouterNextStep(routerAction: RouterAction, stepOutput: StepOutput): NextStepResult {
    const routerOutput = stepOutput.output as { branches: { branchName: string, branchIndex: number, evaluation: boolean }[] } | undefined
    if (isNil(routerOutput) || isNil(routerOutput.branches)) {
        const nextAction = routerAction.nextAction
        if (isNil(nextAction)) {
            return { nextStepNames: [], isTerminal: true }
        }
        return { nextStepNames: [nextAction.name], isTerminal: false }
    }

    const executionType = routerAction.settings.executionType
    const matchedBranches = routerOutput.branches.filter(b => b.evaluation === true)

    if (matchedBranches.length === 0) {
        const nextAction = routerAction.nextAction
        if (isNil(nextAction)) {
            return { nextStepNames: [], isTerminal: true }
        }
        return { nextStepNames: [nextAction.name], isTerminal: false }
    }

    const branchesToExecute = executionType === RouterExecutionType.EXECUTE_FIRST_MATCH
        ? [matchedBranches[0]]
        : matchedBranches

    const nextStepNames: string[] = []
    for (const matchedBranch of branchesToExecute) {
        const branchIndex = matchedBranch.branchIndex - 1
        const branchFirstAction = routerAction.children[branchIndex]
        if (!isNil(branchFirstAction)) {
            nextStepNames.push(branchFirstAction.name)
        }
    }

    if (nextStepNames.length === 0) {
        const nextAction = routerAction.nextAction
        if (isNil(nextAction)) {
            return { nextStepNames: [], isTerminal: true }
        }
        return { nextStepNames: [nextAction.name], isTerminal: false }
    }

    return { nextStepNames, isTerminal: false }
}

function resolveLoopNextStep(loopAction: LoopOnItemsAction, stepOutput: StepOutput): NextStepResult {
    const loopOutput = stepOutput.output as LoopStepResult | undefined

    if (isNil(loopOutput) || isNil(loopOutput.iterations)) {
        const firstLoopAction = loopAction.firstLoopAction
        if (!isNil(firstLoopAction)) {
            return { nextStepNames: [firstLoopAction.name], isTerminal: false }
        }
        return resolveAfterLoop(loopAction)
    }

    const totalItems = loopAction.settings.items
    const itemsArray = Array.isArray(totalItems) ? totalItems : []
    const completedIterations = loopOutput.iterations.length

    if (completedIterations < itemsArray.length && !isNil(loopAction.firstLoopAction)) {
        return { nextStepNames: [loopAction.firstLoopAction.name], isTerminal: false }
    }

    return resolveAfterLoop(loopAction)
}

function resolveAfterLoop(loopAction: LoopOnItemsAction): NextStepResult {
    const nextAction = loopAction.nextAction
    if (isNil(nextAction)) {
        return { nextStepNames: [], isTerminal: true }
    }
    return { nextStepNames: [nextAction.name], isTerminal: false }
}

function findNextStepInsideContainer(flowVersion: FlowVersion, completedStepName: string): NextStepResult | null {
    const allSteps = flowStructureUtil.getAllSteps(flowVersion.trigger)
    for (const step of allSteps) {
        if (step.type === FlowActionType.ROUTER) {
            const routerAction = step as RouterAction
            for (const child of routerAction.children) {
                if (!isNil(child)) {
                    const childSteps = flowStructureUtil.getAllSteps(child)
                    if (childSteps.some(s => s.name === completedStepName)) {
                        const completedInBranch = childSteps.find(s => s.name === completedStepName)
                        if (!isNil(completedInBranch) && !isNil(completedInBranch.nextAction)) {
                            return { nextStepNames: [completedInBranch.nextAction.name], isTerminal: false }
                        }
                        if (!isNil(routerAction.nextAction)) {
                            return { nextStepNames: [routerAction.nextAction.name], isTerminal: false }
                        }
                        return { nextStepNames: [], isTerminal: true }
                    }
                }
            }
        }

        if (step.type === FlowActionType.LOOP_ON_ITEMS) {
            const loopAction = step as LoopOnItemsAction
            if (!isNil(loopAction.firstLoopAction)) {
                const loopSteps = flowStructureUtil.getAllSteps(loopAction.firstLoopAction)
                if (loopSteps.some(s => s.name === completedStepName)) {
                    const completedInLoop = loopSteps.find(s => s.name === completedStepName)
                    if (!isNil(completedInLoop) && !isNil(completedInLoop.nextAction)) {
                        return { nextStepNames: [completedInLoop.nextAction.name], isTerminal: false }
                    }
                    return resolveAfterLoop(loopAction)
                }
            }
        }
    }
    return null
}

async function resolveTargetQueue(params: {
    stepName: string
    flowVersion: FlowVersion
    platformId: string
    log: FastifyBaseLogger
}): Promise<string> {
    const step = flowStructureUtil.getStep(params.stepName, params.flowVersion.trigger)
    const stepWorkerGroupId = step?.settings?.workerGroupId as string | undefined

    if (!isNil(stepWorkerGroupId)) {
        return getWorkerGroupQueueName(stepWorkerGroupId)
    }

    const platformWorkerGroupId = await workerGroupService(params.log).getWorkerGroupId({ platformId: params.platformId })
    if (!isNil(platformWorkerGroupId)) {
        return getWorkerGroupQueueName(platformWorkerGroupId)
    }

    return QueueName.WORKER_JOBS
}

function resolveStepTimeoutSeconds(stepName: string, flowVersion: FlowVersion): number | undefined {
    const step = flowStructureUtil.getStep(stepName, flowVersion.trigger)
    return step?.settings?.timeoutSeconds as number | undefined
}
