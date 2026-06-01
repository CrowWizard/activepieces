import { FlowRunStep } from '@activepieces/shared'
import { repoFactory } from '../../../core/db/repo-factory'
import { FlowRunStepEntity } from './flow-run-step-entity'

export const flowRunStepRepo = repoFactory<FlowRunStep>(FlowRunStepEntity)
