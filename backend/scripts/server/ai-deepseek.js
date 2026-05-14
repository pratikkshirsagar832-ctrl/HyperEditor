/**
 * DeepSeek AI client — text generation and content analysis.
 * Consolidated from ai-client.js.
 */
import { RateLimiter } from './rate-limiter.js';

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat';
const deepseekLimiter = new RateLimiter(1, 2000); // 1 req / 2s

/**
 * Send a prompt to DeepSeek (OpenAI-compatible API).
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.systemInstruction]
 * @param {string} [options.responseMimeType] - 'application/json' enables JSON mode
 * @param {object} [options.config] - { model, temperature, maxOutputTokens }
 * @param {string} [options.jobId]
 * @returns {Promise<{text: string, candidates: Array}>}
 */
export async function generateWithDeepSeek({ prompt, systemInstruction, responseMimeType, config = {}, jobId = '' }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured in .dev.vars');

  // Rate limit: max 1 request per 2 seconds
  await deepseekLimiter.acquire(3, 2000);

  const log = (msg) => { if (jobId) console.log(`[${jobId}] ${msg}`); };

  const body = {
    model: config.model || DEEPSEEK_MODEL,
    messages: [],
    stream: false,
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxOutputTokens || 4096,
  };

  if (systemInstruction) {
    body.messages.push({ role: 'system', content: systemInstruction });
  }
  body.messages.push({ role: 'user', content: prompt });

  if (responseMimeType === 'application/json') {
    body.response_format = { type: 'json_object' };
    if (!prompt.toLowerCase().includes('json')) {
      body.messages[body.messages.length - 1].content += '\n\nReturn ONLY valid JSON.';
    }
  }

  log(`Sending to DeepSeek (${body.model})...`);

  const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';

  return {
    text,
    candidates: [{ content: { parts: [{ text }], role: 'model' } }],
  };
}
