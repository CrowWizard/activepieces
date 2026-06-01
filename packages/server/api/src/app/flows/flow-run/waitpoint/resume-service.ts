import {
    apId,
    EngineHttpResponse,
    ExecutionType,
    FlowRun,
    FlowRunId,
    FlowRunStatus,
    isFlowRunStateTerminal,
    isNil,
    ResumeReason,
    RunEnvironment,
    StreamStepProgress,
} from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { stepLevelSchedulingFlag } from '../../../ee/platform/platform-plan/step-level-scheduling-flag'
import { projectService } from '../../../project/project-service'
import { engineResponseWatcher } from '../../../workers/engine-response-watcher'
import { addToQueue, findFlowRunOrThrow, flowRunService, WEBHOOK_TIMEOUT_MS } from '../flow-run-service'
import { flowRunSideEffects } from '../flow-run-side-effects'
import { stepOrchestrator } from '../step-orchestrator'
import { waitpointService } from './waitpoint-service'
import { Waitpoint, WaitpointResumePayload } from './waitpoint-types'

export const resumeService = (log: FastifyBaseLogger) => ({
    async resumeFromWaitpoint({ flowRunId, waitpointId, resumePayload, workerHandlerId, httpRequestId }: ResumeFromWaitpointParams): Promise<ResumeFromWaitpointResult> {
        const flowRun = await findFlowRunOrThrow(flowRunId)
        const processed = await waitpointService(log).handleResumeSignal({
            flowRunId,
            waitpointId,
            flowRunStatus: flowRun.status,
            projectId: flowRun.projectId,
            resumePayload: resumePayload ?? null,
            workerHandlerId,
            onReady: async (waitpoint) => {
                await enqueueResume({
                    flowRun,
                    waitpoint,
                    resumePayload,
                    workerHandlerId,
                    httpRequestId,
                }, log)
            },
        })
        return { flowRun, stale: !processed }
    },

    async legacyResume({ flowRunId, resumePayload, workerHandlerId }: LegacyResumeParams): Promise<ResumeFromWaitpointResult> {
        const flowRun = await findFlowRunOrThrow(flowRunId)
        if (flowRun.status !== FlowRunStatus.PAUSED) {
            return { flowRun, stale: true }
        }
        await enqueueResume({ flowRun, resumePayload, workerHandlerId }, log)
        return { flowRun, stale: false }
    },

    async handleSyncResumeFlow({ runId, waitpointId, payload, correlationId }: HandleSyncResumeFlowParams): Promise<EngineHttpResponse> {
        const flowRun = await flowRunService(log).getOnePopulatedOrThrow({
            id: runId,
            projectId: undefined,
        })

        if (isFlowRunStateTerminal({ status: flowRun.status, ignoreInternalError: false })) {
            return {
                status: StatusCodes.CONFLICT,
                body: { message: 'Flow run is not paused', flowRunStatus: flowRun.status },
                headers: {},
            }
        }

        const syncServerId = engineResponseWatcher(log).getServerId()
        const { stale } = await this.resumeFromWaitpoint({
            flowRunId: runId,
            waitpointId,
            resumePayload: payload,
            workerHandlerId: syncServerId,
            httpRequestId: correlationId,
        })

        if (stale) {
            return {
                status: StatusCodes.GONE,
                body: { message: 'This link has expired. The action may have already been processed.' },
                headers: {},
            }
        }

        return engineResponseWatcher(log).oneTimeListener<EngineHttpResponse>(correlationId, true, WEBHOOK_TIMEOUT_MS, {
            status: StatusCodes.NO_CONTENT,
            body: {},
            headers: {},
        })
    },

    async legacySyncResume({ runId, payload, correlationId }: LegacySyncResumeParams): Promise<EngineHttpResponse> {
        const flowRun = await findFlowRunOrThrow(runId)
        if (flowRun.status !== FlowRunStatus.PAUSED) {
            return {
                status: StatusCodes.CONFLICT,
                body: { message: 'Flow run is not paused', flowRunStatus: flowRun.status },
                headers: {},
            }
        }
        const syncServerId = engineResponseWatcher(log).getServerId()
        await enqueueResume({ flowRun, resumePayload: payload, workerHandlerId: syncServerId, httpRequestId: correlationId }, log)
        return engineResponseWatcher(log).oneTimeListener<EngineHttpResponse>(correlationId, true, WEBHOOK_TIMEOUT_MS, {
            status: StatusCodes.NO_CONTENT,
            body: {},
            headers: {},
        })
    },
})

async function enqueueResume(params: EnqueueResumeParams, log: FastifyBaseLogger): Promise<void> {
    const { flowRun, waitpoint, resumePayload, workerHandlerId, httpRequestId } = params
    const platformId = await projectService(log).getPlatformId(flowRun.projectId)
    const effectiveWorkerHandlerId = workerHandlerId ?? waitpoint?.workerHandlerId ?? undefined
    const effectiveHttpRequestId = httpRequestId ?? waitpoint?.httpRequestId ?? apId()
    const streamStepProgress = flowRun.environment === RunEnvironment.TESTING
        ? StreamStepProgress.WEBSOCKET
        : StreamStepProgress.NONE

    if (await stepLevelSchedulingFlag.isEnabled(platformId, log) && !isNil(waitpoint) && !isNil(waitpoint.stepName) && waitpoint.stepName !== '') {
        await stepOrchestrator(log).enqueueStepResume({
            flowRunId: flowRun.id,
            projectId: flowRun.projectId,
            platformId,
            flowVersionId: flowRun.flowVersionId,
            stepName: waitpoint.stepName,
            resumePayload: resumePayload ?? undefined,
            resumeReason: ResumeReason.WAITPOINT,
            environment: flowRun.environment,
            logsFileId: flowRun.logsFileId ?? apId(),
            workerHandlerId: effectiveWorkerHandlerId ?? null,
            httpRequestId: effectiveHttpRequestId,
            streamStepProgress,
        })
    }
    else {
        await addToQueue({
            payload: resumePayload,
            flowRun,
            platformId,
            workerHandlerId: effectiveWorkerHandlerId,
            httpRequestId: effectiveHttpRequestId,
            streamStepProgress,
            executionType: ExecutionType.RESUME,
            resumeReason: ResumeReason.WAITPOINT,
        }, log)
    }

    await flowRunSideEffects(log).onResume(flowRun)
}

type SyncResumePayload = {
    body?: unknown
    headers?: Record<string, string>
    queryParams?: Record<string, string>
}

type HandleSyncResumeFlowParams = {
    runId: string
    waitpointId: string
    payload: SyncResumePayload
    correlationId: string
}

type LegacySyncResumeParams = {
    runId: string
    payload: SyncResumePayload
    correlationId: string
}

type ResumeFromWaitpointParams = {
    flowRunId: FlowRunId
    waitpointId: string
    resumePayload: WaitpointResumePayload
    workerHandlerId?: string
    httpRequestId?: string
}

type LegacyResumeParams = {
    flowRunId: FlowRunId
    resumePayload: WaitpointResumePayload
    workerHandlerId?: string
}

type ResumeFromWaitpointResult = {
    flowRun: FlowRun
    stale: boolean
}

type EnqueueResumeParams = {
    flowRun: FlowRun
    waitpoint?: Waitpoint
    resumePayload: WaitpointResumePayload
    workerHandlerId?: string
    httpRequestId?: string
}
