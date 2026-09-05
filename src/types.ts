export type ReviewSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ReviewCategory = 'bug' | 'security' | 'performance' | 'maintainability' | 'docs' | 'style';

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
  confidence: number;
  commitId?: string;
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
