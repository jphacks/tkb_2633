import { Platform } from 'react-native';

import type {
  ApplianceCareAnalysisStage,
  ApplianceCareApiRequest,
  ApplianceCareApiResponse,
} from '@/features/appliance-care/api-contracts';

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 600;

export function applianceCareApiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787';
}

export async function analyzeApplianceCareRequest(
  request: ApplianceCareApiRequest,
  baseUrl = applianceCareApiBaseUrl(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onStage?: (stage: ApplianceCareAnalysisStage) => void,
): Promise<ApplianceCareApiResponse> {
  const normalized = {
    manufacturer: request.manufacturer.trim(),
    productName: request.productName.trim(),
    modelNumber: request.modelNumber.trim(),
    ...(request.category?.trim() ? { category: request.category.trim() } : {}),
  };
  if ([normalized.manufacturer, normalized.productName, normalized.modelNumber]
    .some((value) => value.length === 0 || value.length > 120)) {
    return {
      status: 'error',
      code: 'INVALID_REQUEST',
      message: 'メーカー名・製品名・型番を入力してください（各120文字以内）。',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const startResponse = await fetch(`${baseUrl}/api/appliance-care/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(normalized),
      signal: controller.signal,
    });
    const startPayload: unknown = await readJson(startResponse);
    if (isApiResponse(startPayload)) return startPayload;
    if (!startResponse.ok || !isJobAccepted(startPayload)) {
      return temporaryError('家電解析APIに接続できません。APIサーバーの状態を確認してください。');
    }

    let lastStage: ApplianceCareAnalysisStage | undefined;
    while (!controller.signal.aborted) {
      const statusResponse = await fetch(`${baseUrl}/api/appliance-care/jobs/${encodeURIComponent(startPayload.jobId)}`, {
        method: 'GET',
        signal: controller.signal,
      });
      const statusPayload: unknown = await readJson(statusResponse);
      if (isApiResponse(statusPayload)) return statusPayload;
      if (!statusResponse.ok || !isJobStatus(statusPayload)) {
        return temporaryError('解析状況を確認できません。通信状態を確認して再試行してください。');
      }
      if (statusPayload.stage !== lastStage) {
        lastStage = statusPayload.stage;
        onStage?.(lastStage);
      }
      if (statusPayload.done) {
        return isApiResponse(statusPayload.result)
          ? statusPayload.result
          : temporaryError('解析結果を読み取れませんでした。もう一度検索してください。');
      }
      await delay(POLL_INTERVAL_MS);
    }
    return temporaryError('解析がタイムアウトしました。時間をおいて再試行してください。');
  } catch {
    return temporaryError(controller.signal.aborted
      ? '解析がタイムアウトしました。時間をおいて再試行してください。'
      : '家電解析APIに接続できません。APIサーバーと接続先URLを確認してください。');
  } finally {
    clearTimeout(timer);
  }
}

function temporaryError(message: string): ApplianceCareApiResponse {
  return { status: 'error', code: 'TEMPORARY_NETWORK_ERROR', message };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isApiResponse(value: unknown): value is ApplianceCareApiResponse {
  if (!value || typeof value !== 'object' || !('status' in value)) return false;
  const status = value.status;
  if (status === 'not_found') return 'message' in value && typeof value.message === 'string';
  if (status === 'ambiguous') return 'candidates' in value && Array.isArray(value.candidates);
  if (status === 'error') return 'code' in value && 'message' in value
    && typeof value.code === 'string' && typeof value.message === 'string';
  if (status === 'verified') return 'product' in value && 'officialSources' in value && 'analysis' in value;
  return false;
}

function isJobAccepted(value: unknown): value is { jobId: string } {
  return Boolean(value && typeof value === 'object' && 'jobId' in value && typeof value.jobId === 'string');
}

function isJobStatus(value: unknown): value is {
  stage: ApplianceCareAnalysisStage;
  done: boolean;
  result?: unknown;
} {
  if (!value || typeof value !== 'object' || !('stage' in value) || !('done' in value)) return false;
  return (value.stage === 'product_verification' || value.stage === 'official_manual_analysis')
    && typeof value.done === 'boolean';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
