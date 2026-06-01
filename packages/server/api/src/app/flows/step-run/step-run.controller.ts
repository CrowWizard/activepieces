import {
    ActivepiecesError,
    ApId,
    CompleteFlowRunRequest,
    ErrorCode,
    ExecuteStepRunRequest,
    ExecuteStepRunResponse,
    ExecutionType,
    FlowRunStepType,
    GetStepRunResponse,
    isFlowRunStateTerminal,
    isNil,
    LATEST_JOB_DATA_SCHEMA_VERSION,
    Permission,
    PrincipalType,
    SchedulingMode,
    SERVICE_KEY_SECURITY_OPENAPI,
    StepOutputStatus,
    StreamStepProgress,
    WorkerJobType,
} from '@activepieces/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { apId } from '../../../helper/id-generator'
import { ProjectResourceType } from '../../core/security/authorization/common'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { stepLevelSchedulingFlag } from '../../ee/platform/platform-plan/step-level-scheduling-flag'
import { projectService } from '../../project/project-service'
import { jobQueue, JobType } from '../../workers/job-queue/job-queue'
import { flowRunRepo } from '../flow-run/flow-run-service'
import { flowRunStepRepo } from '../flow-run/flow-run-step-repo'
import { flowRunStepService } from '../flow-run/flow-run-step-service'

export const stepRunController: FastifyPluginAsyncZod = async (fastify) => {

    fastify.post('/execute', ExecuteStepRunRequestConfig, async (request) => {
        const { flowRunId, stepName, projectId, executionType, resumePayload, resumeReason } = request.body

        const platformId = await projectService(request.log).getPlatformId(projectId)
        if (!await stepLevelSchedulingFlag.isEnabled(platformId, request.log)) {
            throw new ActivepiecesError({
                code: ErrorCode.PERMISSION_DENIED,
                params: { message: 'External scheduling is not enabled for this platform' },
            })
        }

        const flowRun = await flowRunRepo().findOneBy({ id: flowRunId, projectId })
        if (isNil(flowRun)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'flow_run',
                    entityId: flowRunId,
                    message: 'Flow run not found',
                },
            })
        }

        if (flowRun.schedulingMode !== SchedulingMode.EXTERNAL) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'Flow run is not in external scheduling mode. Set schedulingMode to EXTERNAL when creating the flow run.',
                },
            })
        }

        const stepRecord = await flowRunStepService(request.log).save({
            flowRunId,
            projectId,
            stepName,
            stepType: FlowRunStepType.PIECE,
            status: StepOutputStatus.RUNNING,
            queuedAt: new Date().toISOString(),
        })

        const logsFileId = flowRun.logsFileId ?? apId()

        await jobQueue(request.log).add({
            id: `${flowRunId}-${stepName}-${stepRecord.id}`,
            type: JobType.ONE_TIME,
            data: {
                schemaVersion: LATEST_JOB_DATA_SCHEMA_VERSION,
                jobType: WorkerJobType.EXECUTE_STEP,
                flowRunId,
                flowVersionId: flowRun.flowVersionId,
                stepName,
                executionType: executionType ?? ExecutionType.BEGIN,
                resumePayload,
                resumeReason,
                platformId: flowRun.projectId,
                projectId,
                environment: flowRun.environment ?? 'PRODUCTION',
                logsFileId,
                workerHandlerId: null,
                httpRequestId: null,
                streamStepProgress: StreamStepProgress.NONE,
                skipOrchestration: true,
                stepTimeoutSeconds: undefined,
                traceContext: {},
            },
        })

        const response: ExecuteStepRunResponse = {
            stepRunId: stepRecord.id,
            flowRunId,
            stepName,
            status: StepOutputStatus.RUNNING,
        }
        return response
    })

    fastify.get('/:id', GetStepRunRequestConfig, async (request) => {
        const stepRecord = await flowRunStepRepo().findOneBy({
            id: request.params.id,
            projectId: request.projectId,
        })
        if (isNil(stepRecord)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'step_run',
                    entityId: request.params.id,
                    message: 'Step run not found',
                },
            })
        }

        const response: GetStepRunResponse = {
            id: stepRecord.id,
            flowRunId: stepRecord.flowRunId,
            stepName: stepRecord.stepName,
            stepType: stepRecord.stepType,
            status: stepRecord.status,
            input: stepRecord.input,
            output: stepRecord.output,
            duration: stepRecord.duration,
            errorMessage: stepRecord.errorMessage,
            queuedAt: stepRecord.queuedAt,
            startedAt: stepRecord.startedAt,
            finishedAt: stepRecord.finishedAt,
            retryCount: stepRecord.retryCount,
        }
        return response
    })

    fastify.post('/:flowRunId/complete', CompleteFlowRunRequestConfig, async (request) => {
        const { flowRunId } = request.params
        const { status, failedStep } = request.body
        const projectId = request.projectId

        const platformId = await projectService(request.log).getPlatformId(projectId)
        if (!await stepLevelSchedulingFlag.isEnabled(platformId, request.log)) {
            throw new ActivepiecesError({
                code: ErrorCode.PERMISSION_DENIED,
                params: { message: 'External scheduling is not enabled for this platform' },
            })
        }

        const flowRun = await flowRunRepo().findOneBy({ id: flowRunId, projectId })
        if (isNil(flowRun)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'flow_run',
                    entityId: flowRunId,
                    message: 'Flow run not found',
                },
            })
        }

        if (flowRun.schedulingMode !== SchedulingMode.EXTERNAL) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'Flow run is not in external scheduling mode.',
                },
            })
        }

        if (isFlowRunStateTerminal({ status: flowRun.status, ignoreInternalError: false })) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'Flow run is already in a terminal state.',
                },
            })
        }

        const updatedRun = await flowRunRepo().save({
            ...flowRun,
            status,
            failedStep: failedStep ?? null,
            finishTime: new Date().toISOString(),
        })

        return updatedRun
    })
}

const ExecuteStepRunRequestConfig = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_RUN,
            {
                type: ProjectResourceType.BODY,
            },
        ),
    },
    schema: {
        tags: ['step-runs'],
        description: 'Execute a single step in external scheduling mode',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        body: ExecuteStepRunRequest,
        response: {
            [StatusCodes.OK]: ExecuteStepRunResponse,
        },
    },
}

const GetStepRunRequestConfig = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.READ_RUN,
            {
                type: ProjectResourceType.TABLE,
                tableName: 'flow_run_step',
            },
        ),
    },
    schema: {
        tags: ['step-runs'],
        description: 'Get step run result',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        params: z.object({
            id: ApId,
        }),
        response: {
            [StatusCodes.OK]: GetStepRunResponse,
        },
    },
}

const CompleteFlowRunRequestConfig = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_RUN,
            {
                type: ProjectResourceType.BODY,
            },
        ),
    },
    schema: {
        tags: ['step-runs'],
        description: 'Complete a flow run in external scheduling mode',
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        params: z.object({
            flowRunId: ApId,
        }),
        body: CompleteFlowRunRequest,
    },
}
