import type { ApplianceCareAnalysisDraft } from '@/features/appliance-care/contracts';

export interface ApplianceCareApiRequest {
  manufacturer: string;
  productName: string;
  modelNumber: string;
  category?: string;
}

export interface ProductCandidate {
  manufacturer: string;
  productName: string;
  modelNumber?: string;
  officialProductUrl: string;
}

export interface ProductVerifiedResponse {
  status: 'verified';
  product: {
    manufacturer: string;
    productName: string;
    modelNumber: string;
    category?: string;
  };
  officialSources: {
    productUrl?: string;
    manualUrl: string;
  };
  analysis: ApplianceCareAnalysisDraft;
}

export interface ProductAmbiguousResponse {
  status: 'ambiguous';
  candidates: ProductCandidate[];
}

export interface ProductNotFoundResponse {
  status: 'not_found';
  message: string;
}

export interface ProductAnalysisErrorResponse {
  status: 'error';
  code: 'INVALID_REQUEST' | 'RATE_LIMITED' | 'SEARCH_FAILED' | 'MANUAL_NOT_FOUND' | 'MANUAL_FETCH_FAILED'
    | 'AI_ANALYSIS_FAILED' | 'INVALID_AI_OUTPUT';
  message: string;
}

export type ApplianceCareApiResponse = ProductVerifiedResponse
  | ProductAmbiguousResponse
  | ProductNotFoundResponse
  | ProductAnalysisErrorResponse;
