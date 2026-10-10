// Seedream variations of the kitten icon with the diff card raised and horizontal bars.
// Usage: bun branding/generate-seedream.ts
const KEY = process.env.OPENROUTER_API_KEY;
if (KEY == null || KEY === '') throw new Error('OPENROUTER_API_KEY missing');
const SOURCE = `${import.meta.dir}/kitten`;
const OUT = `${process.env.HOME}/Pictures/pr-review-icon-candidates/kitten`;
const MODEL = 'bytedance-seed/seedream-5-0-pro';
const reference = `data:image/png;base64,${Buffer.from(await Bun.file(`${SOURCE}/bytedance-seed__seedream-5-0-pro.png`).arrayBuffer()).toString('base64')}`;
const CARD = `The card: a cream paper sign held up high, its top edge just under the kitten's chin, both little white paws gripping the top edge. The card is wide (about two thirds of the icon width) and shows two thick HORIZONTAL bars running left to right, stacked one above the other like lines in a code diff: a soft green bar on top and a soft pink bar below it, each with rounded ends. No vertical stripes.`;
const EDIT = `Edit this app icon. Keep the kitten exactly as it is (face, fur, colours, eyes, expression), the green checkmark, the dusk sky and clouds, the rounded-square icon shape and the soft painterly Ghibli style. Change only the card. ${CARD} The kitten's face stays large and fully visible above the card.`;
const FRESH = `A macOS app icon of an adorable Birman kitten in a soft Studio Ghibli style: a tiny fluffy cream kitten with a pale caramel seal-point mask, small tufted ears, big gentle sapphire-blue eyes with soft highlights, a tiny pink nose and a small content smile, head slightly tilted. A small hand-painted green checkmark floats beside its head. ${CARD} Background: a soft painterly dusk sky, violet fading to lavender, with a couple of pink-tinted clouds. Soft ink lines, flat warm pastel colours, gentle shading, whimsical and cosy. Rounded-square macOS app icon on a plain white background, the kitten's face fills most of the icon. No text, no letters, no logos, no watermark.`;
const RUNS = [
  { name: 'seedream-edit-a', prompt: EDIT, seed: 11, isEdit: true },
  { name: 'seedream-edit-b', prompt: EDIT, seed: 42, isEdit: true },
  { name: 'seedream-fresh-a', prompt: FRESH, seed: 7, isEdit: false },
  { name: 'seedream-fresh-b', prompt: FRESH, seed: 99, isEdit: false },
];
interface ImageResponse { data?: { b64_json?: string }[]; error?: { message?: string }; usage?: { cost?: number } }
async function generate(run: (typeof RUNS)[number]): Promise<string> {
  const started = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'PR Review icon' },
    body: JSON.stringify({ model: MODEL, prompt: run.prompt, aspect_ratio: '1:1', seed: run.seed, ...(run.isEdit ? { input_references: [{ type: 'image_url', image_url: { url: reference } }] } : {}) }),
  });
  const json = (await response.json()) as ImageResponse;
  if (!response.ok) return `${run.name}: HTTP ${response.status} ${json.error?.message ?? ''}`;
  const data = json.data?.[0]?.b64_json;
  if (data == null) return `${run.name}: no image`;
  const file = `${OUT}/${run.name}.png`;
  await Bun.write(file, Buffer.from(data, 'base64'));
  return `${file} cost=$${json.usage?.cost?.toFixed(4) ?? '?'} ${Math.round((Date.now() - started) / 1000)}s`;
}
const results = await Promise.allSettled(RUNS.map(generate));
results.forEach((result) => console.log(result.status === 'fulfilled' ? result.value : `ERR ${String(result.reason).slice(0, 200)}`));
