import { inspect } from 'node:util'
import { onCallService } from '@activepieces/server-utils'
import {
    ActivepiecesError,
    EngineOperationType,
    EngineResponseStatus,
    ErrorCode,
    ExecuteStepJobData,
    ExecuteStepOperation,
    FlowRunStatus,
    FlowVersion,
    GenericStepOutput,
    isFlowRunStateTerminal,
    isNil,
    StepOutput,
    StepOutputStatus,
    tryCatch,
    WorkerJobType,
} from '@activepieces/shared'
import { flowCache } from '../../cache/flow/flow-cache'
import { system, WorkerSystemProp } from '../../config/configs'
import { workerSettings } from '../../config/worker-settings'
import { JobContext, JobHandler, JobResultKind, SynchronousJobResult } from '../types'
import { provisionFlowPieces } from '../utils/flow-helpers'

export const executeStepJob: JobHandler<ExecuteStepJobData, SynchronousJobResult> = {
    jobType: WorkerJobType.EXECUTE_STEP,
    async execute(ctx: JobContext, data: ExecuteStepJobData): Promise<SynchronousJobResult> {
        const timeoutInSeconds = data.stepTimeoutSeconds ?? workerSettings.getSettings().FLOW_TIMEOUT_SECONDS

        const flowRunStatus = await ctx.apiClient.getFlowRunStatus({
            flowRunId: data.flowRunId,
            projectId: data.projectId,
        })
        if (!isNil(flowRunStatus) && isFlowRunStateTerminal({ status: flowRunStatus, ignoreInternalError: false })) {
            ctx.log.info({ flowRunId: data.flowRunId, stepName: data.stepName, flowRunStatus }, 'Flow run is already terminal — skipping step execution')
            return {
                kind: JobResultKind.SYNCHRONOUS,
                status: EngineResponseStatus.OK,
                response: createFailedStepOutput(data.stepName, `Flow run is ${flowRunStatus}`),
            }
        }

        const flowVersion = await flowCache(ctx.log, ctx.apiClient).getVersion({ flowVersionId: data.flowVersionId })
        if (isNil(flowVersion)) {
            ctx.log.info({ flowVersionId: data.flowVersionId }, 'Flow version not found, skipping')
            return {
                kind: JobResultKind.SYNCHRONOUS,
                status: EngineResponseStatus.INTERNAL_ERROR,
                response: createFailedStepOutput(data.stepName, 'Flow version not found'),
                errorMessage: 'Flow version not found',
            }
        }

        const { data: provisioned, error: provisionError } = await tryCatch(() => provisionFlowPieces({ flowVersion, platformId: data.platformId, flowId: flowVersion.flowId, projectId: data.projectId, log: ctx.log, apiClient: ctx.apiClient }))

        await ctx.apiClient.markStepStarted({
            flowRunId: data.flowRunId,
            stepName: data.stepName,
            projectId: data.projectId,
        })
        if (provisionError) {
            await reportStepStatus(ctx, data, FlowRunStatus.INTERNAL_ERROR)
            throw provisionError
        }
        if (!provisioned) {
            return {
                kind: JobResultKind.SYNCHRONOUS,
                status: EngineResponseStatus.INTERNAL_ERROR,
                response: createFailedStepOutput(data.stepName, 'Failed to provision pieces'),
                errorMessage: 'Failed to provision pieces',
            }
        }

        const stepOutputs = await ctx.apiClient.getStepOutputs({
            flowRunId: data.flowRunId,
            projectId: data.projectId,
        })

        const sandbox = ctx.sandboxManager.acquire({ log: ctx.log, apiClient: ctx.apiClient })
        try {
            await sandbox.start({
                flowVersionId: flowVersion.id,
                platformId: data.platformId,
                mounts: [],
            })

            const operation = buildStepOperation(ctx, data, flowVersion, stepOutputs as Record<string, StepOutput>, timeoutInSeconds)
            const result = await sandbox.execute(
                EngineOperationType.EXECUTE_STEP,
                operation,
                { timeoutInSeconds },
            )

            if (result.status === EngineResponseStatus.LOG_SIZE_EXCEEDED) {
                await reportStepStatus(ctx, data, FlowRunStatus.LOG_SIZE_EXCEEDED)
                return {
                    kind: JobResultKind.SYNCHRONOUS,
                    status: EngineResponseStatus.OK,
                    response: createFailedStepOutput(data.stepName, 'Log size exceeded'),
                }
            }

            if (result.status === EngineResponseStatus.INTERNAL_ERROR) {
                await reportStepStatus(ctx, data, FlowRunStatus.INTERNAL_ERROR)
                return {
                    kind: JobResultKind.SYNCHRONOUS,
                    status: EngineResponseStatus.OK,
                    response: createFailedStepOutput(data.stepName, result.error ?? 'Internal error'),
                }
            }

            return {
                kind: JobResultKind.SYNCHRONOUS,
                status: EngineResponseStatus.OK,
                response: result.response as StepOutput,
            }
        }
        catch (e) {
            await ctx.sandboxManager.invalidate(ctx.log)
            if (e instanceof ActivepiecesError) {
                if (e.error.code === ErrorCode.SANDBOX_EXECUTION_TIMEOUT) {
                    await reportStepStatus(ctx, data, FlowRunStatus.TIMEOUT)
                    return {
                        kind: JobResultKind.SYNCHRONOUS,
                        status: EngineResponseStatus.OK,
                        response: createFailedStepOutput(data.stepName, 'Step execution timed out'),
                    }
                }
                if (e.error.code === ErrorCode.SANDBOX_MEMORY_ISSUE) {
                    await reportStepStatus(ctx, data, FlowRunStatus.MEMORY_LIMIT_EXCEEDED)
                    return {
                        kind: JobResultKind.SYNCHRONOUS,
                        status: EngineResponseStatus.OK,
                        response: createFailedStepOutput(data.stepName, 'Memory limit exceeded'),
                    }
                }
                if (e.error.code === ErrorCode.SANDBOX_LOG_SIZE_EXCEEDED) {
                    await reportStepStatus(ctx, data, FlowRunStatus.LOG_SIZE_EXCEEDED)
                    return {
                        kind: JobResultKind.SYNCHRONOUS,
                        status: EngineResponseStatus.OK,
                        response: createFailedStepOutput(data.stepName, 'Log size exceeded'),
                    }
                }
            }
            await reportStepStatus(ctx, data, FlowRunStatus.INTERNAL_ERROR)
            throw e
        }
        finally {
            await ctx.sandboxManager.release(ctx.log)
        }
    },
}

function buildStepOperation(
    ctx: JobContext,
    data: ExecuteStepJobData,
    flowVersion: FlowVersion,
    stepOutputs: Record<string, StepOutput>,
    timeoutInSeconds: number,
): ExecuteStepOperation {
    return {
        flowVersion,
        flowRunId: data.flowRunId,
        stepName: data.stepName,
        executionType: data.executionType,
        stepOutputs,
        resumePayload: data.resumePayload,
        resumeReason: data.resumeReason,
        projectId: data.projectId,
        platformId: data.platformId,
        runEnvironment: data.environment,
        workerHandlerId: data.workerHandlerId ?? null,
        httpRequestId: data.httpRequestId ?? null,
        streamStepProgress: data.streamStepProgress,
        logsFileId: data.logsFileId,
        timeoutInSeconds,
        engineToken: ctx.engineToken,
        internalApiUrl: ctx.internalApiUrl,
        publicApiUrl: ctx.publicApiUrl,
    }
}

function createFailedStepOutput(stepName: string, errorMessage: string): StepOutput {
    return GenericStepOutput.create({
        type: 'PIECE' as const,
        status: StepOutputStatus.FAILED,
        input: {},
    }).setErrorMessage(errorMessage) as StepOutput
}

async function reportStepStatus(
    ctx: JobContext,
    data: ExecuteStepJobData,
    status: FlowRunStatus,
): Promise<void> {
    await ctx.apiClient.uploadRunLog({
        runId: data.flowRunId,
        status,
        projectId: data.projectId,
        streamStepProgress: data.streamStepProgress,
        finishTime: new Date().toISOString(),
    })

    if (status === FlowRunStatus.INTERNAL_ERROR && isDedicatedWorker()) {
        onCallService(ctx.log, workerSettings.getSettings().PAGE_ONCALL_WEBHOOK).page({
            code: ErrorCode.ENGINE_OPERATION_FAILURE,
            message: `Step execution for flow run ${data.flowRunId} ended with INTERNAL_ERROR`,
            params: { runId: data.flowRunId, flowVersionId: data.flowVersionId, projectId: data.projectId },
        }).catch((e) => ctx.log.error({ runId: data.flowRunId, error: inspect(e) }, 'Failed to send on-call page for INTERNAL_ERROR'))
    }
}

function isDedicatedWorker(): boolean {
    return !isNil(system.get(WorkerSystemProp.WORKER_GROUP_ID))
}
