import { ManualFetchError, ManualNotFoundError, resolveOfficialManual } from './manual-resolver.mjs';
import { InvalidAiOutputError, analyzeOfficialManual } from './manual-analyzer.mjs';
import { ProductResolutionError, resolveProduct } from './product-resolver.mjs';

export async function analyzeApplianceCare(request, dependencies) {
  let product;
  try {
    product = await dependencies.resolveProduct(request);
  } catch (error) {
    if (error instanceof ProductResolutionError) return apiError('SEARCH_FAILED', 'メーカー公式情報を確認できませんでした。');
    return apiError('SEARCH_FAILED', 'メーカー公式情報の検索に失敗しました。');
  }

  if (product.status === 'not_found') {
    return { status: 'not_found', message: '入力された製品をメーカー公式情報から確認できませんでした。メーカー名・製品名・型番を確認してください。' };
  }
  if (product.status === 'ambiguous') return { status: 'ambiguous', candidates: product.candidates };

  let manual;
  try {
    manual = await dependencies.resolveManual(product);
  } catch (error) {
    if (error instanceof ManualNotFoundError) return apiError('MANUAL_NOT_FOUND', 'メーカー公式の取扱説明書を特定できませんでした。');
    if (error instanceof ManualFetchError) return apiError('MANUAL_FETCH_FAILED', 'メーカー公式資料を安全に取得できませんでした。');
    return apiError('SEARCH_FAILED', 'メーカー公式の取扱説明書を検索できませんでした。');
  }

  let analysis;
  let analyzedManual = manual;
  try {
    const manualCandidates = [manual, ...(Array.isArray(manual.fallbackCandidates) ? manual.fallbackCandidates : [])];
    let lastAnalysisError;
    for (const candidate of manualCandidates) {
      try {
        analysis = await dependencies.analyzeManual(product, candidate);
        analyzedManual = candidate;
        break;
      } catch (error) {
        if (error instanceof InvalidAiOutputError) throw error;
        lastAnalysisError = error;
      }
    }
    if (!analysis) throw lastAnalysisError ?? new Error('No usable official manual was analyzed');
  } catch (error) {
    if (error instanceof InvalidAiOutputError) return apiError('INVALID_AI_OUTPUT', '解析結果の形式または出典を検証できませんでした。');
    if (error instanceof ManualFetchError) return apiError('MANUAL_FETCH_FAILED', '公式Webマニュアルを取得できませんでした。');
    return apiError('AI_ANALYSIS_FAILED', '公式資料の解析に失敗しました。時間をおいて再試行してください。');
  }

  return {
    status: 'verified',
    product: {
      manufacturer: product.manufacturer,
      productName: product.productName,
      modelNumber: product.modelNumber,
      ...(request.category ? { category: request.category } : {}),
    },
    officialSources: {
      ...(product.officialProductUrl ? { productUrl: product.officialProductUrl } : {}),
      manualUrl: analyzedManual.url,
    },
    analysis,
  };
}

export function createDefaultDependencies({ ai, fetchImpl = fetch, now } = {}) {
  return {
    resolveProduct: (request) => resolveProduct(request, { ai }),
    resolveManual: (product) => resolveOfficialManual(product, { ai, fetchImpl }),
    analyzeManual: (product, manual) => analyzeOfficialManual(product, manual, { ai, fetchImpl, now }),
  };
}

export function validateApplianceCareRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = ['manufacturer', 'productName', 'modelNumber'];
  for (const field of fields) {
    if (typeof value[field] !== 'string') return false;
    const normalized = value[field].trim();
    if (normalized.length < 1 || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) return false;
  }
  if (value.category !== undefined
    && (typeof value.category !== 'string' || value.category.trim().length === 0 || value.category.length > 80)) return false;
  return true;
}

function apiError(code, message) {
  return { status: 'error', code, message };
}
