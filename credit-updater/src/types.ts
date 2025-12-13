export interface GenerationInput {
  prompt: string;
  durationSeconds?: number;
  orientation?: 'portrait' | 'landscape';
}

export interface GenerationResult {
  jobId: string;
  publicUrl?: string;
  artifactsDir?: string;
  metadata?: Record<string, unknown>;
}










