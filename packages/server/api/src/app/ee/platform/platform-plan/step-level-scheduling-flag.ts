import { isNil, PlatformId } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { distributedStore } from '../../../database/redis-connections'
import { platformPlanService } from './platform-plan.service'

const STEP_LEVEL_SCHEDULING_KEY = (platformId: PlatformId): string => `platform_plan:stepLevelScheduling:${platformId}`

export const stepLevelSchedulingFlag = {
    async isEnabled(platformId: PlatformId, log: FastifyBaseLogger): Promise<boolean> {
        const cached = await distributedStore.getBoolean(STEP_LEVEL_SCHEDULING_KEY(platformId))
        if (!isNil(cached)) {
            return cached
        }

        const plan = await platformPlanService(log).getOrCreateForPlatform(platformId)
        await distributedStore.putBoolean(STEP_LEVEL_SCHEDULING_KEY(platformId), plan.stepLevelSchedulingEnabled)
        return plan.stepLevelSchedulingEnabled
    },

    async refresh(platformId: PlatformId, value: boolean): Promise<void> {
        await distributedStore.putBoolean(STEP_LEVEL_SCHEDULING_KEY(platformId), value)
    },
}
