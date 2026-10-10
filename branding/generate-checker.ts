// Generates checker-mascot icon candidates via OpenRouter. Usage: bun branding/generate-checker.ts
const KEY = process.env.OPENROUTER_API_KEY;
if (KEY == null || KEY === '') throw new Error('OPENROUTER_API_KEY missing');
const OUT = `${process.env.HOME}/Pictures/pr-review-icon-candidates/checker`;
const BRIEF = `Design a macOS app icon for "PR Review", a fast, keyboard-first app for reviewing and merging GitHub pull requests.
Mascot: an original, cute, very clean little "checker" character, a soft rounded blob/pill-shaped buddy whose body is itself a checkmark or carries one, with two simple vertical capsule eyes (solid near-black, no highlights, no mouth). Friendly, calm, confident, like a tiny reviewer who just approved your PR.
Style references (for feel only, do not copy): Grok's minimal bot companions (flat shapes, capsule eyes, no mouth), Lochie Axon's soft clean product illustration, Aave's soft pastel ghost branding, and the Readout macOS app icon (premium, glossy-but-restrained squircle, subtle depth, crisp silhouette).
Rendering: smooth soft-3D / clay with gentle gradients and a soft inner glow, very few shapes, generous negative space, no outlines, no texture, no noise. Must read instantly at 32px.
Palette: deep ink squircle background with a soft indigo-to-violet gradient glow; mascot in pearl white to pale lavender; one accent of fresh green on the check.
Rules: macOS Big Sur squircle app icon on a plain white canvas, centered, mascot fills ~65% of the squircle, 1:1 square. No text, no letters, no logos, no watermark, no particles, no sparkles, no scene.`;
const VARIANTS = [
  { name: 'pill', extra: 'Concept: the mascot is a rounded pill-shaped body tilted slightly, with a green checkmark on its belly.' },
  { name: 'check', extra: 'Concept: the mascot\'s whole body is a chunky, soft, inflated checkmark shape with the two capsule eyes on the long stroke.' },
  { name: 'ghost', extra: 'Concept: a soft ghost-like blob (Aave-ish silhouette) peeking up from the bottom edge, holding a small green check badge.' },
  { name: 'peek', extra: 'Concept: a round bot head peeking over a diff card (two soft rows, one green, one pink), head tilted ~15 degrees.' },
];
const MODELS = ['openai/gpt-5.4-image-2', 'google/gemini-3-pro-image', 'google/gemini-nano-banana-2.1'];
interface ChatResponse { choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[]; error?: { message?: string }; usage?: { cost?: number } }
async function generate(model: string, variant: { name: string; extra: string }): Promise<string> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'PR Review icon' },
    body: JSON.stringify({ model, modalities: ['image', 'text'], messages: [{ role: 'user', content: `${BRIEF}\n${variant.extra}` }], usage: { include: true } }),
  });
  const json = (await response.json()) as ChatResponse;
  if (!response.ok) return `${model} ${variant.name}: HTTP ${response.status} ${json.error?.message ?? ''}`;
  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (url == null) return `${model} ${variant.name}: no image`;
  const [meta, data] = url.split(',');
  const file = `${OUT}/${variant.name}--${model.split('/')[1]}.${meta?.includes('jpeg') ? 'jpg' : 'png'}`;
  await Bun.write(file, Buffer.from(data ?? '', 'base64'));
  return `${file} cost=$${json.usage?.cost?.toFixed(4) ?? '?'}`;
}
const results = await Promise.allSettled(MODELS.flatMap((model) => VARIANTS.map((variant) => generate(model, variant))));
results.forEach((result) => console.log(result.status === 'fulfilled' ? result.value : `ERR ${String(result.reason).slice(0, 200)}`));
