// Renders the kitten icon brief across the strongest OpenRouter image models via /api/v1/images.
// Usage: bun branding/generate-kitten.ts
const KEY = process.env.OPENROUTER_API_KEY;
if (KEY == null || KEY === '') throw new Error('OPENROUTER_API_KEY missing');
// Writes candidates outside the repo; the chosen one is copied into branding/kitten by hand.
const OUT = `${process.env.HOME}/Pictures/pr-review-icon-candidates/kitten`;
const PROMPT = `A macOS app icon of an adorable Birman kitten in Studio Ghibli style, cute enough that people smile at it in their Dock.
The kitten: a tiny young kitten (not an adult cat), big head, short little muzzle, small fluffy ears with soft tufts, fluffy cream fur, a soft pale caramel seal-point mask so the face stays bright, a tiny pink nose, a small content smile. Big gentle sparkling sapphire-blue eyes with a large white highlight and a small second highlight. Head tilted slightly, curious and delighted. Little white toe-bean paws.
It peeks up over the top edge of a small cream paper card with one soft green stripe and one soft pink stripe, both paws resting on the card, and a small hand-painted green checkmark floats beside its head.
Style: Studio Ghibli hand-drawn look, soft ink lines, flat warm cel colours with one soft shadow, a gentle painterly dusk sky in deep indigo fading to violet with a couple of soft clouds. Warm, cosy, whimsical. Not 3D, not glossy.
Composition: the kitten's face is the hero and fills most of the icon; the card sits small at the bottom. Rounded-square macOS app icon shape on a plain white background, centered. No text, no letters, no logos, no watermark.`;
const MODELS = [
  'openai/gpt-image-2.5-sunburst',
  'google/gemini-nano-banana-2.1',
  'black-forest-labs/flux-3-image',
  'bytedance-seed/seedream-5-0-pro',
  'recraft/recraft-v4.1-pro',
  'microsoft/mai-image-2.6',
  'x-ai/grok-imagine-image-2.0',
  'qwen/qwen-image-3-pro',
  'meta/muse-image',
  'krea/krea-2-large',
];
interface ImageResponse { data?: { b64_json?: string }[]; error?: { message?: string }; usage?: { cost?: number } }
async function generate(model: string): Promise<string> {
  const started = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'PR Review icon' },
    body: JSON.stringify({ model, prompt: PROMPT, aspect_ratio: '1:1', n: 1 }),
  });
  const json = (await response.json()) as ImageResponse;
  if (!response.ok) return `${model}: HTTP ${response.status} ${json.error?.message ?? ''}`;
  const data = json.data?.[0]?.b64_json;
  if (data == null) return `${model}: no image`;
  const file = `${OUT}/${model.replace('/', '__')}.png`;
  await Bun.write(file, Buffer.from(data, 'base64'));
  return `${file} cost=$${json.usage?.cost?.toFixed(4) ?? '?'} ${Math.round((Date.now() - started) / 1000)}s`;
}
const results = await Promise.allSettled(MODELS.map(generate));
results.forEach((result) => console.log(result.status === 'fulfilled' ? result.value : `ERR ${String(result.reason).slice(0, 200)}`));
