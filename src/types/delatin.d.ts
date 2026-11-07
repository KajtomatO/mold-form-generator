declare module 'delatin' {
  export default class Delatin {
    constructor(data: ArrayLike<number>, width: number, height?: number);
    /** Flat [x0, y0, x1, y1, ...] grid coordinates of the mesh vertices. */
    coords: number[];
    /** Flat vertex index triples. */
    triangles: number[];
    run(maxError?: number): void;
    refine(): void;
    getMaxError(): number;
    getRMSD(): number;
    heightAt(x: number, y: number): number;
  }
}
