import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { lightboxScale } from './lightbox';

const box = { width: 1256, height: 840 };

describe('lightboxScale', () => {
  test('fits the whole image when that keeps it at half size or more', () => {
    expect(lightboxScale({ width: 2560, height: 1440 }, box)).toEqual({ scale: 1256 / 2560, scrolls: false });
    expect(lightboxScale({ width: 1170, height: 1600 }, box)).toEqual({ scale: 840 / 1600, scrolls: false });
    expect(lightboxScale({ width: 400, height: 300 }, box)).toEqual({ scale: 1, scrolls: false });
  });

  test('a tall phone screenshot stays at half size and scrolls the rest', () => {
    expect(lightboxScale({ width: 1170, height: 2532 }, box)).toEqual({ scale: 0.5, scrolls: true });
  });

  test('whole mode fits the entire tall screenshot and never scrolls', () => {
    expect(lightboxScale({ width: 1170, height: 2532 }, box, 'whole')).toEqual({ scale: 840 / 2532, scrolls: false });
    expect(lightboxScale({ width: 400, height: 300 }, box, 'whole')).toEqual({ scale: 1, scrolls: false });
  });

  test('property: whole mode never scrolls and never shows more than readable mode', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 1, max: 20_000 }), (width, height) => {
        const whole = lightboxScale({ width, height }, box, 'whole');
        expect(whole.scrolls).toBe(false);
        expect(whole.scale).toBeLessThanOrEqual(lightboxScale({ width, height }, box, 'readable').scale + 1e-9);
      }),
      { numRuns: 2_000 },
    );
  });

  test('a very wide image still fits the width even below half size', () => {
    expect(lightboxScale({ width: 6000, height: 1000 }, box).scale).toBeCloseTo(1256 / 6000);
  });

  test('property: never wider than the box, never above 1x, and scrolls only when it must', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 1, max: 20_000 }), (width, height) => {
        const { scale, scrolls } = lightboxScale({ width, height }, box);
        expect(scale).toBeLessThanOrEqual(1);
        expect(width * scale).toBeLessThanOrEqual(box.width + 1e-6);
        const fitsWhole = Math.min(box.width / width, box.height / height, 1) >= 0.5;
        if (fitsWhole) expect(scrolls).toBe(false);
        expect(scrolls).toBe(height * scale > box.height + 1);
      }),
      { numRuns: 2_000 },
    );
  });
});
