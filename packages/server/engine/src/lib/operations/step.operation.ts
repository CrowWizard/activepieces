import {
    EngineResponse,
    EngineResponseStatus,
    ExecuteStepOperation,
    flowStructureUtil,
    GenericStepOutput,
    isNil,
    StepOutput,
    StepOutputStatus,
} from '@activepieces/shared'
import { EngineConstants } from '../handler/context/engine-constants'
import { FlowExecutorContext } from '../handler/context/flow-execution-context'
import { flowExecutor } from '../handler/flow-executor'
import { flowRunProgressReporter } from '../helper/flow-run-progress-reporter'

export const stepOperation = {
    async execute(operation: ExecuteStepOperation): Promise<EngineResponse<StepOutput>> {
        const { flowVersion, stepName, stepOutputs } = operation

        const executionState = FlowExecutorContext.fromStepOutputs({
            steps: stepOutputs,
            engineApi: {
                engineToken: operation.engineToken,
                internalApiUrl: operation.internalApiUrl,
            },
        })

        const step = flowStructureUtil.getActionOrThrow(stepName, flowVersion.trigger)

        const constants = EngineConstants.fromExecuteStepInput(operation)

        flowRunProgressReporter.init()

        const result = await flowExecutor.execute({
            action: step,
            executionState,
            constants,
        })

        const stepOutput = result.getStepOutput(stepName)
        if (isNil(stepOutput)) {
            return {
                status: EngineResponseStatus.INTERNAL_ERROR,
                response: GenericStepOutput.create({
                    type: step.type,
                    status: StepOutputStatus.FAILED,
                    input: {},
                }).setErrorMessage('Step output not found after execution'),
            }
        }

        await flowRunProgressReporter.sendUpdate({
            engineConstants: constants,
            flowExecutorContext: result,
            stepNameToUpdate: stepName,
        }).catch((err) => {
            console.error('[StepOperation] Progress report failed', err)
        })

        return {
            status: EngineResponseStatus.OK,
            response: stepOutput,
        }
    },
}
