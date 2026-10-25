import type {
  ApplianceCareAnalysisStage,
  ApplianceCareApiRequest,
  ApplianceCareApiResponse,
} from '@/features/appliance-care/api-contracts';

export function applianceCareApiBaseUrl(): string {
  return '';
}

export async function analyzeApplianceCareRequest(
  _request: ApplianceCareApiRequest,
  _baseUrl?: string,
  _timeoutMs?: number,
  _onStage?: (stage: ApplianceCareAnalysisStage) => void,
): Promise<ApplianceCareApiResponse> {
  return {
    status: 'error',
    code: 'WEB_AI_DISABLED',
    message: 'Web版ではAIと通信しません。入力した製品情報は送信されていません。メーカー公式サイトから手動で確認してください。',
  };
}
