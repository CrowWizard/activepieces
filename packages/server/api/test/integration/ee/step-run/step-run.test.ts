import {
    ErrorCode,
    FlowRunStatus,
    SchedulingMode,
} from '@activepieces/shared'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../../helpers/test-setup'
import { FastifyInstance } from 'fastify'
import { describeWithAuth } from '../../../../helpers/describe-with-auth'
import { createMockFlowRun } from '../../../../helpers/mocks'
import { db } from '../../../../helpers/db'
import { stepLevelSchedulingFlag } from '../../../../../src/app/ee/platform/platform-plan/step-level-scheduling-flag'
import { apId } from '@activepieces/shared'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describeWithAuth('Step Run API', () => app!, (setup) => {
    it('should reject execute when feature flag is disabled', async () => {
        const ctx = await setup()
        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            schedulingMode: SchedulingMode.EXTERNAL,
            status: FlowRunStatus.QUEUED,
        })
        await db.save('flow_run', flowRun)
        await stepLevelSchedulingFlag.refresh(ctx.platform.id, false)

        const response = await ctx.post('/v1/step-runs/execute', {
            flowRunId: flowRun.id,
            stepName: 'step_1',
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(403)
    })

    it('should reject execute when flow run is not in EXTERNAL scheduling mode', async () => {
        const ctx = await setup()
        await stepLevelSchedulingFlag.refresh(ctx.platform.id, true)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            schedulingMode: SchedulingMode.INTERNAL,
            status: FlowRunStatus.QUEUED,
        })
        await db.save('flow_run', flowRun)

        const response = await ctx.post('/v1/step-runs/execute', {
            flowRunId: flowRun.id,
            stepName: 'step_1',
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(400)
        const body = response.json()
        expect(body.code).toBe(ErrorCode.VALIDATION)
    })

    it('should reject execute when flow run does not exist', async () => {
        const ctx = await setup()
        await stepLevelSchedulingFlag.refresh(ctx.platform.id, true)

        const response = await ctx.post('/v1/step-runs/execute', {
            flowRunId: apId(),
            stepName: 'step_1',
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(404)
    })

    it('should accept execute when feature flag is enabled and schedulingMode is EXTERNAL', async () => {
        const ctx = await setup()
        await stepLevelSchedulingFlag.refresh(ctx.platform.id, true)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            schedulingMode: SchedulingMode.EXTERNAL,
            status: FlowRunStatus.QUEUED,
        })
        await db.save('flow_run', flowRun)

        const response = await ctx.post('/v1/step-runs/execute', {
            flowRunId: flowRun.id,
            stepName: 'step_1',
            projectId: ctx.project.id,
        })

        expect(response.statusCode).toBe(200)
        const body = response.json()
        expect(body.flowRunId).toBe(flowRun.id)
        expect(body.stepName).toBe('step_1')
        expect(body.status).toBe('RUNNING')
    })

    it('should reject complete when flow run is already terminal', async () => {
        const ctx = await setup()
        await stepLevelSchedulingFlag.refresh(ctx.platform.id, true)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            schedulingMode: SchedulingMode.EXTERNAL,
            status: FlowRunStatus.SUCCEEDED,
        })
        await db.save('flow_run', flowRun)

        const response = await ctx.post(`/v1/step-runs/${flowRun.id}/complete`, {
            status: 'SUCCEEDED',
        })

        expect(response.statusCode).toBe(400)
        const body = response.json()
        expect(body.code).toBe(ErrorCode.VALIDATION)
    })

    it('should reject complete when flow run is not in EXTERNAL scheduling mode', async () => {
        const ctx = await setup()
        await stepLevelSchedulingFlag.refresh(ctx.platform.id, true)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            schedulingMode: SchedulingMode.INTERNAL,
            status: FlowRunStatus.QUEUED,
        })
        await db.save('flow_run', flowRun)

        const response = await ctx.post(`/v1/step-runs/${flowRun.id}/complete`, {
            status: 'SUCCEEDED',
        })

        expect(response.statusCode).toBe(400)
    })

    it('should complete a flow run in EXTERNAL scheduling mode', async () => {
        const ctx = await setup()
        await stepLevelSchedulingFlag.refresh(ctx.platform.id, true)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            schedulingMode: SchedulingMode.EXTERNAL,
            status: FlowRunStatus.QUEUED,
        })
        await db.save('flow_run', flowRun)

        const response = await ctx.post(`/v1/step-runs/${flowRun.id}/complete`, {
            status: 'SUCCEEDED',
        })

        expect(response.statusCode).toBe(200)
    })

    it('should return step run by id', async () => {
        const ctx = await setup()
        await stepLevelSchedulingFlag.refresh(ctx.platform.id, true)

        const flowRun = createMockFlowRun({
            projectId: ctx.project.id,
            schedulingMode: SchedulingMode.EXTERNAL,
            status: FlowRunStatus.QUEUED,
        })
        await db.save('flow_run', flowRun)

        const executeResponse = await ctx.post('/v1/step-runs/execute', {
            flowRunId: flowRun.id,
            stepName: 'step_1',
            projectId: ctx.project.id,
        })

        const { stepRunId } = executeResponse.json()

        const getResponse = await ctx.get(`/v1/step-runs/${stepRunId}`)
        expect(getResponse.statusCode).toBe(200)

        const body = getResponse.json()
        expect(body.id).toBe(stepRunId)
        expect(body.flowRunId).toBe(flowRun.id)
        expect(body.stepName).toBe('step_1')
    })

    it('should return 404 for non-existent step run', async () => {
        const ctx = await setup()

        const response = await ctx.get(`/v1/step-runs/${apId()}`)
        expect(response.statusCode).toBe(404)
    })
})
