import { z } from 'zod'
import { ApId } from '../../../core/common/id-generator'
import { ResumeReason } from '../../engine/engine-operation'
import { ExecutionType } from '../../flow-run/execution/execution-output'
import { FlowRunStepType } from '../../flow-run/execution/flow-run-step'
import { StepOutputStatus } from '../../flow-run/execution/step-output'

export const SchedulingMode = {
    INTERNAL: 'INTERNAL',
    EXTERNAL: 'EXTERNAL',
} as const
export type SchedulingMode = (typeof SchedulingMode)[keyof typeof SchedulingMode]

export const ExecuteStepRunRequest = z.object({
    flowRunId: ApId,
    stepName: z.string(),
    projectId: ApId,
    executionType: z.nativeEnum(ExecutionType).default(ExecutionType.BEGIN),
    resumePayload: z.unknown().optional(),
    resumeReason: z.nativeEnum(ResumeReason).optional(),
})
export type ExecuteStepRunRequest = z.infer<typeof ExecuteStepRunRequest>

export const ExecuteStepRunResponse = z.object({
    stepRunId: ApId,
    flowRunId: ApId,
    stepName: z.string(),
    status: z.nativeEnum(StepOutputStatus),
})
export type ExecuteStepRunResponse = z.infer<typeof ExecuteStepRunResponse>

export const GetStepRunResponse = z.object({
    id: ApId,
    flowRunId: ApId,
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
export type GetStepRunResponse = z.infer<typeof GetStepRunResponse>

export const CompleteFlowRunRequest = z.object({
    status: z.enum(['SUCCEEDED', 'FAILED']),
    failedStep: z.object({
        name: z.string(),
        displayName: z.string(),
        message: z.string().optional(),
    }).optional(),
})
export type CompleteFlowRunRequest = z.infer<typeof CompleteFlowRunRequest>
