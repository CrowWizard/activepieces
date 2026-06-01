import { FlowRunStepType, StepOutputStatus } from '@activepieces/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../../database/database-common'

type FlowRunStepSchema = {
    id: string
    created: string
    updated: string
    flowRunId: string
    projectId: string
    stepName: string
    stepType: FlowRunStepType
    status: StepOutputStatus
    input: unknown
    output: unknown
    duration: number | null
    errorMessage: unknown
    path: unknown
    queueName: string | null
    queuedAt: string | null
    startedAt: string | null
    finishedAt: string | null
    retryCount: number
}

export const FlowRunStepEntity = new EntitySchema<FlowRunStepSchema>({
    name: 'flow_run_step',
    columns: {
        ...BaseColumnSchemaPart,
        flowRunId: {
            ...ApIdSchema,
            nullable: false,
        },
        projectId: {
            ...ApIdSchema,
            nullable: false,
        },
        stepName: {
            type: String,
            length: 255,
            nullable: false,
        },
        stepType: {
            type: String,
            nullable: false,
            enum: FlowRunStepType,
        },
        status: {
            type: String,
            nullable: false,
            enum: StepOutputStatus,
        },
        input: {
            type: 'jsonb',
            nullable: true,
        },
        output: {
            type: 'jsonb',
            nullable: true,
        },
        duration: {
            type: Number,
            nullable: true,
        },
        errorMessage: {
            type: 'jsonb',
            nullable: true,
        },
        path: {
            type: 'jsonb',
            nullable: false,
            default: [],
        },
        queueName: {
            type: String,
            length: 255,
            nullable: true,
        },
        queuedAt: {
            type: 'timestamp with time zone',
            nullable: true,
        },
        startedAt: {
            type: 'timestamp with time zone',
            nullable: true,
        },
        finishedAt: {
            type: 'timestamp with time zone',
            nullable: true,
        },
        retryCount: {
            type: Number,
            nullable: false,
            default: 0,
        },
    },
    indices: [
        {
            name: 'idx_flow_run_step_flow_run_id',
            columns: ['flowRunId'],
        },
        {
            name: 'idx_flow_run_step_flow_run_id_step_name',
            columns: ['flowRunId', 'stepName'],
        },
        {
            name: 'idx_flow_run_step_project_id',
            columns: ['projectId'],
        },
    ],
    relations: {
        flowRun: {
            type: 'many-to-one',
            target: 'flow_run',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'flowRunId',
                foreignKeyConstraintName: 'fk_flow_run_step_flow_run_id',
            },
        },
        project: {
            type: 'many-to-one',
            target: 'project',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'projectId',
                foreignKeyConstraintName: 'fk_flow_run_step_project_id',
            },
        },
    },
})
