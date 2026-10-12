/**
 * Upper-leaning estimate of a request's prompt tokens, computed without a tokenizer.
 *
 * It only sets the size of the up-front budget reservation; the real cost always comes from the
 * provider's usage numbers. English averages ~4 characters per token, so counting ASCII at 3
 * characters per token and every other character as a whole token over-estimates for most text.
 * Images and files are base64 blobs whose length says little about tokens, so they get flat
 * allowances instead of being counted as text.
 */
const IMAGE_TOKENS = 2_000;
const FILE_BYTES_PER_TOKEN = 50;
const PER_MESSAGE_OVERHEAD = 10;

export function estimatePromptTokens(body: unknown): number {
  let ascii = 0;
  let other = 0;
  let extra = 0;

  const countText = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) < 128) ascii++;
      else other++;
    }
  };

  const visit = (node: unknown, parentKey: string | undefined): void => {
    if (typeof node === 'string') {
      if (node.startsWith('data:')) {
        // Inline data URL (OpenAI image_url / file_data).
        extra += node.startsWith('data:image/') ? IMAGE_TOKENS : fileTokens(node.length);
      } else if (parentKey === 'data' || parentKey === 'file_data') {
        // Raw base64 payload (Anthropic image/document source).
        extra += fileTokens(node.length);
      } else {
        countText(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, parentKey);
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (obj.type === 'image' || obj.type === 'input_image' || obj.type === 'image_url') {
        // Whatever its encoding (base64, URL, file id), an image costs roughly a fixed amount.
        extra += IMAGE_TOKENS;
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'role' || k === 'type') extra += 1;
        else visit(v, k);
      }
    }
  };

  const b = (body ?? {}) as Record<string, unknown>;
  // Only the parts that become prompt tokens.
  for (const field of ['system', 'messages', 'tools', 'input', 'instructions', 'tool_choice', 'response_format']) {
    if (b[field] !== undefined) visit(b[field], field);
  }
  const messageCount = Array.isArray(b.messages) ? b.messages.length : Array.isArray(b.input) ? b.input.length : 1;
  return Math.ceil(ascii / 3) + other + extra + messageCount * PER_MESSAGE_OVERHEAD;
}

function fileTokens(base64Length: number): number {
  return Math.ceil((base64Length * 0.75) / FILE_BYTES_PER_TOKEN);
}
