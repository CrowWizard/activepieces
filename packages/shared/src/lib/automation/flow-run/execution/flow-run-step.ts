import { z } from 'zod'
import { BaseModelSchema, Nullable } from '../../../core/common/base-model'
import { ApId } from '../../../core/common/id-generator'
import { FlowActionType } from '../../flows/actions/action'
import { FlowTriggerType } from '../../flows/triggers/trigger'
import { StepOutputStatus } from './step-output'

export enum FlowRunStepType {
    PIECE = 'PIECE',
    CODE = 'CODE',
    ROUTER = 'ROUTER',
    LOOP_ON_ITEMS = 'LOOP_ON_ITEMS',
    TRIGGER = 'TRIGGER',
}

export function toFlowRunStepType(type: FlowActionType | FlowTriggerType): FlowRunStepType {
    switch (type) {
        case FlowActionType.PIECE:
            return FlowRunStepType.PIECE
        case FlowActionType.CODE:
            return FlowRunStepType.CODE
        case FlowActionType.ROUTER:
            return FlowRunStepType.ROUTER
        case FlowActionType.LOOP_ON_ITEMS:
            return FlowRunStepType.LOOP_ON_ITEMS
        case FlowTriggerType.PIECE:
        case FlowTriggerType.EMPTY:
            return FlowRunStepType.TRIGGER
        default:
            return FlowRunStepType.PIECE
    }
}

export const FlowRunStepPath = z.array(z.tuple([z.string(), z.number()]))
export type FlowRunStepPath = z.infer<typeof FlowRunStepPath>

export const FlowRunStep = z.object({
    ...BaseModelSchema,
    flowRunId: ApId,
    projectId: ApId,
    stepName: z.string(),
    stepType: z.nativeEnum(FlowRunStepType),
    status: z.nativeEnum(StepOutputStatus),
    input: Nullable(z.unknown()),
    output: Nullable(z.unknown()),
    duration: Nullable(z.number()),
    errorMessage: Nullable(z.unknown()),
    path: FlowRunStepPath,
    queueName: Nullable(z.string()),
    queuedAt: Nullable(z.string()),
    startedAt: Nullable(z.string()),
    finishedAt: Nullable(z.string()),
    retryCount: z.number(),
})

export type FlowRunStep = z.infer<typeof FlowRunStep>

export const SaveFlowRunStepParams = z.object({
    flowRunId: ApId,
    projectId: ApId,
    stepName: z.string(),
    stepType: z.nativeEnum(FlowRunStepType),
    status: z.nativeEnum(StepOutputStatus),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    duration: z.number().optional(),
    errorMessage: z.unknown().optional(),
    path: FlowRunStepPath.optional(),
    queueName: z.string().optional(),
    queuedAt: z.string().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    retryCount: z.number().optional(),
})

export type SaveFlowRunStepParams = z.infer<typeof SaveFlowRunStepParams>
