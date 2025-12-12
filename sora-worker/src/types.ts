export type VideoOrientation = 'portrait' | 'landscape';

export interface GenerationInput {
  prompt: string;
  durationSeconds: 10 | 15;
  orientation: VideoOrientation;
  imageUrls?: string[];
}

export interface GenerationResult {
  jobId: string;
  publicUrl?: string;
  downloadUrl?: string;
  artifactsDir: string;
  metadata?: Record<string, unknown>;
}


