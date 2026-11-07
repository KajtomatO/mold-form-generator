import { describe, expect, it } from 'vitest';
import Module from 'manifold-3d';

describe('Manifold in Node', () => {
  it('loads by its default wasm path and computes a correct boolean', async () => {
    const api = await Module();
    api.setup();
    const { Manifold } = api;
    const box = Manifold.cube([20, 20, 20], true);
    const ball = Manifold.sphere(6, 128);
    const result = box.subtract(ball);
    const expected = 8000 - (4 / 3) * Math.PI * 216;
    expect(result.status()).toBe('NoError');
    expect(Math.abs(result.volume() - expected) / expected).toBeLessThan(0.005);
    result.delete();
    ball.delete();
    box.delete();
  });
});
