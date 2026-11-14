import test from 'node:test';
import assert from 'node:assert/strict';
import {videoGeminiProvider} from '../src/analysis/video-gemini.mjs';

test('provider requests the same editing score and field enums that its validator accepts', async () => {
  let request;
  const input = {scoreEditing: true, mediaId: 'media', sha256: 'abc', durationMs: 27648,
    snapshot: {episode: {}, claim: {}, sources: []}};
  const report = {audioAvailable: true, visualAvailable: true, summary: 'Перевірено',
    editingQuality: {score: 85, rationale: 'На 20-й секунді читабельний фінал'},
    coverage: [{interval: 0, audio: 'Чітка мова', visual: 'Фото й штамп'}], findings: []};
  const provider = videoGeminiProvider({query: async () => ({rows: [{state: 'passed', sha256: 'abc',
    expires_at: new Date(Date.now() + 60000)}]})}, {
    env: {GEMINI_API_KEY: 'test', VIDEO_AUDIT_ENABLED: 'true', ANALYSIS_ENABLED: 'true',
      ANALYSIS_PRICING_EXPIRES_AT: new Date(Date.now() + 60000).toISOString()},
    client: {files: {get: async () => ({state: 'ACTIVE', uri: 'https://example.test/media'})},
      models: {generateContent: async value => {request = value; return {text: JSON.stringify(report),
        usageMetadata: {promptTokenCount: 100, candidatesTokenCount: 50,
          promptTokensDetails: [{modality: 'VIDEO', tokenCount: 80}]}};}}},
  });
  const result = await provider('test', input, {fileName: 'media', startedAt: Date.now()});
  assert.equal(result.type, 'success');
  assert.equal(result.drafts.editingQuality.score, 85);
  assert.ok(request.config.responseSchema.required.includes('editingQuality'));
  assert.equal(request.config.responseSchema.properties.editingQuality.properties.score.type, 'INTEGER');
  const field = request.config.responseSchema.properties.findings.items.properties.field;
  assert.equal(field.nullable, true);
  assert.ok(field.enum.includes('script'));
});
