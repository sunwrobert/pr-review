// Cute Ghibli Birman kitten icon. Runs with a source image edit it; runs without one draw from the brief alone. Usage: bun branding/generate-cat.ts
const KEY = process.env.OPENROUTER_API_KEY;
if (KEY == null || KEY === '') throw new Error('OPENROUTER_API_KEY missing');
const DIR = `${process.env.HOME}/Pictures/pr-review-icon-candidates/checker`;
const sourceOf = async (name: string): Promise<string> => Buffer.from(await Bun.file(`${DIR}/${name}`).arrayBuffer()).toString('base64');
const BRIEF = `A macOS app icon: an adorable Birman KITTEN in Studio Ghibli style, cute enough that people smile at it in their Dock.
Kitten: a young kitten, not an adult cat. Big head relative to the body, short muzzle, small soft rounded ears with fluffy tufts (still clearly cat ears, not a blob), fluffy cream fur with a soft, light seal-point mask (warm caramel-brown, pale enough that the face stays bright and friendly, not a dark muddy mask), tiny pink nose, a small happy closed-mouth smile. Big, gentle, sparkly sapphire-blue eyes: large and round-ish, with a big white highlight and a small second highlight, like Ghibli kittens and the cats in The Cat Returns. Head tilted about 15 degrees, curious and delighted. Pure white little toe-bean paws.
Pose: peeking up over the top edge of a small cream paper card that has one soft green stripe and one soft pink stripe (a tiny diff), both paws resting on the card, with a small hand-painted green checkmark beside its head.
Style: Studio Ghibli hand-drawn look, soft ink lines with gentle weight variation, flat warm cel colours with one soft shadow, a gentle painterly dusk sky in deep indigo to violet with a couple of soft clouds. Warm, cosy, whimsical. Not 3D, not glossy, not a western cartoon sticker.
Composition: the kitten's face is the hero and fills about 60% of the squircle; the card is small at the bottom. Must read clearly at 32px.
Rules: 1:1, macOS Big Sur squircle on a plain white canvas. No text, no letters, no logos, no watermark, no sparkles, no particles.`;
const RUNS = [
  { model: 'openai/gpt-5.4-image-2', name: 'kitten-a', source: null, extra: '' },
  { model: 'openai/gpt-5.4-image-2', name: 'kitten-b', source: null, extra: 'Make it extra cute: slightly bigger eyes, a tiny blush on each cheek, one ear slightly flopped.' },
  { model: 'google/gemini-3-pro-image', name: 'kitten-c', source: null, extra: '' },
  { model: 'google/gemini-3-pro-image', name: 'kitten-d', source: 'ghibli-c--gemini-3-pro-image.png', extra: 'Use the attached image for the sky, card and layout, but replace the cat with the kitten described above.' },
];
interface ChatResponse { choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[]; error?: { message?: string }; usage?: { cost?: number } }
async function run({ model, name, source: sourceName, extra }: { model: string; name: string; source: string | null; extra: string }): Promise<string> {
  const image = sourceName == null ? [] : [{ type: 'image_url', image_url: { url: `data:image/png;base64,${await sourceOf(sourceName)}` } }];
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'PR Review icon' },
    body: JSON.stringify({
      model,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content: [{ type: 'text', text: `${BRIEF}\n${extra}` }, ...image] }],
      usage: { include: true },
    }),
  });
  const json = (await response.json()) as ChatResponse;
  if (!response.ok) return `${name}: HTTP ${response.status} ${json.error?.message ?? ''}`;
  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (url == null) return `${name}: no image`;
  const [meta, data] = url.split(',');
  const file = `${DIR}/${name}--${model.split('/')[1]}.${meta?.includes('jpeg') ? 'jpg' : 'png'}`;
  await Bun.write(file, Buffer.from(data ?? '', 'base64'));
  return `${file} cost=$${json.usage?.cost?.toFixed(4) ?? '?'}`;
}
const results = await Promise.allSettled(RUNS.map(run));
results.forEach((result) => console.log(result.status === 'fulfilled' ? result.value : `ERR ${String(result.reason).slice(0, 200)}`));
