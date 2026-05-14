// DeepSeek API helper for Cloudflare Worker (no npm deps needed - uses Workers fetch)
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

export async function generateWithDeepSeek(
  apiKey: string,
  prompt: string,
  options?: {
    systemInstruction?: string;
    responseMimeType?: string;
  }
) {
  const body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream: boolean;
    response_format?: { type: string };
  } = {
    model: 'deepseek-chat',
    messages: [],
    stream: false,
  };

  if (options?.systemInstruction) {
    body.messages.push({ role: 'system', content: options.systemInstruction });
  }

  body.messages.push({ role: 'user', content: prompt });

  if (options?.responseMimeType === 'application/json') {
    body.response_format = { type: 'json_object' };
  }

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

  const data: {
    choices?: Array<{ message?: { content?: string } }>;
  } = await response.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
  };
}
