import { apId, FlowRunStep, isNil, SaveFlowRunStepParams, StepOutput, StepOutputStatus } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { flowRunStepRepo } from './flow-run-step-repo'

export const flowRunStepService = (log: FastifyBaseLogger) => ({
    async save(params: SaveFlowRunStepParams): Promise<FlowRunStep> {
        const existing = await flowRunStepRepo().findOneBy({
            flowRunId: params.flowRunId,
            stepName: params.stepName,
            projectId: params.projectId,
        })

        if (!isNil(existing)) {
            log.info({ flowRunId: params.flowRunId, stepName: params.stepName }, '[flowRunStepService#save] Updating existing step output')
            return flowRunStepRepo().save({
                ...existing,
                status: params.status,
                input: params.input ?? existing.input,
                output: params.output ?? existing.output,
                duration: params.duration ?? existing.duration,
                errorMessage: params.errorMessage ?? existing.errorMessage,
                path: params.path ?? existing.path,
                queueName: params.queueName ?? existing.queueName,
                queuedAt: params.queuedAt ?? existing.queuedAt,
                startedAt: params.startedAt ?? existing.startedAt,
                finishedAt: params.finishedAt ?? existing.finishedAt,
                retryCount: params.retryCount ?? existing.retryCount,
            })
        }

        return flowRunStepRepo().save({
            id: apId(),
            flowRunId: params.flowRunId,
            projectId: params.projectId,
            stepName: params.stepName,
            stepType: params.stepType,
            status: params.status,
            input: params.input ?? null,
            output: params.output ?? null,
            duration: params.duration ?? null,
            errorMessage: params.errorMessage ?? null,
            path: params.path ?? [],
            queueName: params.queueName ?? null,
            queuedAt: params.queuedAt ?? null,
            startedAt: params.startedAt ?? null,
            finishedAt: params.finishedAt ?? null,
            retryCount: params.retryCount ?? 0,
        })
    },

    async getStepOutputs({ flowRunId, projectId }: { flowRunId: string, projectId: string }): Promise<Record<string, StepOutput>> {
        const steps = await flowRunStepRepo().findBy({ flowRunId, projectId })
        const result: Record<string, StepOutput> = {}
        for (const step of steps) {
            result[step.stepName] = deserializeStepOutput(step)
        }
        return result
    },

    async getStepOutput({ flowRunId, stepName, projectId }: { flowRunId: string, stepName: string, projectId?: string }): Promise<StepOutput | null> {
        const query: Record<string, string> = { flowRunId, stepName }
        if (!isNil(projectId)) {
            query.projectId = projectId
        }
        const step = await flowRunStepRepo().findOneBy(query)
        if (isNil(step)) {
            return null
        }
        return deserializeStepOutput(step)
    },

    async deleteByFlowRunId({ flowRunId }: { flowRunId: string }): Promise<void> {
        await flowRunStepRepo().delete({ flowRunId })
        log.info({ flowRunId }, '[flowRunStepService#deleteByFlowRunId] Step outputs deleted')
    },
})

function deserializeStepOutput(step: FlowRunStep): StepOutput {
    return {
        type: step.stepType,
        status: step.status as StepOutputStatus,
        input: step.input,
        output: step.output,
        duration: step.duration ?? undefined,
        errorMessage: step.errorMessage ?? undefined,
    } as StepOutput
}
