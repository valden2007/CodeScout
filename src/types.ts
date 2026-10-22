export type ReviewSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ReviewCategory = 'bug' | 'security' | 'performance' | 'maintainability' | 'docs' | 'style';

// Батч 20b (ядро доверия): confidence — целое число 0..100, степень уверенности
// модели в находке; proof — короткое доказательство (цитата из кода или причина).
// Порог «подтверждено кодом / предположение модели» — в response-parser
// (CONFIDENCE_VERIFIED_THRESHOLD). fingerprint — идентичность находки для
// подавления ложных срабатываний (extension/src/findingsStore).
export interface ReviewConfig {
  provider: string;
  model: string;
  apiKey: string;
  maxTokens: number;
}

export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface ReviewIssue {
  file: string;
  line: number;
  category: ReviewCategory;
  severity: ReviewSeverity;
  description: string;
  suggestion?: string;
  code?: string;
  confidence: number;   // 0..100, целое (валидация в response-parser)
  commitId?: string;
  proof?: string;       // цитата из кода или причина; '' если доказательств нет
  fingerprint?: string;
}

export interface ReviewResult {
  issues: ReviewIssue[];
  summary: string;
  filesAnalyzed: number;
}

export interface LLMProvider {
  review(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface GitHubPullRequestContext {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  botLogin?: string;
}
