import { httpClient, HttpMethod } from '@activepieces/pieces-common';
import { ActivepiecesError, ErrorCode } from '@activepieces/shared';

const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com';
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 60;

type DashScopeTaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNKNOWN';

type SubmitTaskParams = {
  apiKey: string;
  model: string;
  submitPath: string;
  input: Record<string, unknown>;
  parameters?: Record<string, unknown>;
};

type PollResult = {
  taskStatus: DashScopeTaskStatus;
  outputUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

const submitAsyncTask = async ({
  apiKey,
  model,
  submitPath,
  input,
  parameters,
}: SubmitTaskParams): Promise<string> => {
  const response = await httpClient.sendRequest({
    url: `${DASHSCOPE_BASE_URL}${submitPath}`,
    method: HttpMethod.POST,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: {
      model,
      input,
      ...(parameters ? { parameters } : {}),
    },
  });

  const taskId = response.body?.output?.task_id;
  if (!taskId) {
    throw new ActivepiecesError({
      code: ErrorCode.ENGINE_OPERATION_FAILURE,
      params: {
        message: `DashScope submit failed: no task_id returned. Response: ${JSON.stringify(
          response.body
        )}`,
      },
    });
  }
  return taskId;
};

const pollTaskResult = async ({
  apiKey,
  taskId,
}: {
  apiKey: string;
  taskId: string;
}): Promise<PollResult> => {
  const response = await httpClient.sendRequest({
    url: `${DASHSCOPE_BASE_URL}/api/v1/tasks/${taskId}`,
    method: HttpMethod.GET,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const taskStatus: DashScopeTaskStatus =
    response.body?.output?.task_status ?? 'UNKNOWN';
  const results = response.body?.output?.results;
  const outputUrl =
    results?.[0]?.url ?? response.body?.output?.results?.[0]?.b64_image ?? null;
  const errorCode = response.body?.output?.code ?? null;
  const errorMessage = response.body?.output?.message ?? null;

  return { taskStatus, outputUrl, errorCode, errorMessage };
};

const waitForTaskCompletion = async ({
  apiKey,
  taskId,
}: {
  apiKey: string;
  taskId: string;
}): Promise<string> => {
  let attempt = 0;
  let interval = POLL_INTERVAL_MS;

  while (attempt < POLL_MAX_ATTEMPTS) {
    const result = await pollTaskResult({ apiKey, taskId });

    if (result.taskStatus === 'SUCCEEDED') {
      if (!result.outputUrl) {
        throw new ActivepiecesError({
          code: ErrorCode.ENGINE_OPERATION_FAILURE,
          params: {
            message: 'DashScope task succeeded but no output URL found',
          },
        });
      }
      return result.outputUrl;
    }

    if (result.taskStatus === 'FAILED') {
      throw new ActivepiecesError({
        code: ErrorCode.ENGINE_OPERATION_FAILURE,
        params: {
          message: `DashScope task failed: ${result.errorCode} - ${result.errorMessage}`,
        },
      });
    }

    attempt++;
    await sleep(interval);
    interval = Math.min(interval * 2, 8000);
  }

  throw new ActivepiecesError({
    code: ErrorCode.ENGINE_OPERATION_FAILURE,
    params: {
      message: `DashScope task timed out after ${POLL_MAX_ATTEMPTS} polls (${Math.round(
        (POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000
      )}s)`,
    },
  });
};

const downloadImageAsBuffer = async ({
  url,
}: {
  url: string;
}): Promise<Buffer> => {
  const response = await httpClient.sendRequest({
    url,
    method: HttpMethod.GET,
    responseType: 'arraybuffer',
  });

  if (response.body instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(response.body));
  }
  if (Buffer.isBuffer(response.body)) {
    return response.body;
  }
  return Buffer.from(response.body);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const dashScopeClient = {
  submitAndWait: async ({
    apiKey,
    model,
    submitPath,
    input,
    parameters,
  }: SubmitTaskParams): Promise<string> => {
    const taskId = await submitAsyncTask({
      apiKey,
      model,
      submitPath,
      input,
      parameters,
    });
    return waitForTaskCompletion({ apiKey, taskId });
  },

  downloadAsBuffer: downloadImageAsBuffer,
};
