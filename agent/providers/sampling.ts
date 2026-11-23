/** Optional model-card settings; omitted values retain the server's defaults. */
export type ModelSamplingSettings = {
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
};

export function samplingParameters(settings?: ModelSamplingSettings): Record<string, number> {
  const params: Record<string, number> = {};
  for (const [key, wire] of [
    ['temperature', 'temperature'],
    ['topP', 'top_p'],
    ['presencePenalty', 'presence_penalty'],
  ] as const) {
    const value = settings?.[key];
    if (value !== undefined) params[wire] = value;
  }
  return params;
}
