import { Platform } from 'react-native';

import type { ApplianceCareApiRequest, ApplianceCareApiResponse } from '@/features/appliance-care/api-contracts';

const DEFAULT_TIMEOUT_MS = 120_000;

export function applianceCareApiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787';
}

export async function analyzeApplianceCareRequest(
  request: ApplianceCareApiRequest,
  baseUrl = applianceCareApiBaseUrl(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
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
    const response = await fetch(baseUrl + '/api/appliance-care/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(normalized),
      signal: controller.signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error('APIの応答を読み取れませんでした。サーバーの状態を確認してください。');
    }
    if (isApiResponse(value)) return value;
    throw new Error(response.ok
      ? 'APIの応答形式が正しくありません。'
      : 'APIサーバーに接続できませんでした（HTTP ' + response.status + '）。');
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new Error('解析がタイムアウトしました。公式検索と説明書解析を再試行してください。');
    }
    if (cause instanceof Error && cause.message.startsWith('APIの応答')) throw cause;
    if (cause instanceof Error && cause.message.startsWith('APIサーバー')) throw cause;
    throw new Error('家電解析APIに接続できません。APIサーバーと接続先URLを確認してください。');
  } finally {
    clearTimeout(timer);
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
