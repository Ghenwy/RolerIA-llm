const stateSize = 624;
const period = 397;

/** Minimal MT19937 port matching CPython random.Random(int). */
export class PythonRandom {
  readonly #state = new Uint32Array(stateSize);
  #index = stateSize;

  constructor(seedBytes: Uint8Array) {
    const key: number[] = [];
    for (let end = seedBytes.length; end > 0; end -= 4) {
      const start = Math.max(0, end - 4);
      let word = 0;
      for (let cursor = start; cursor < end; cursor += 1) word = (word * 256 + (seedBytes[cursor] ?? 0)) >>> 0;
      key.push(word);
    }
    this.#initByArray(key.length === 0 ? [0] : key);
  }

  #initGenRand(seed: number): void {
    this.#state[0] = seed >>> 0;
    for (let index = 1; index < stateSize; index += 1) {
      const previous = this.#state[index - 1] ?? 0;
      this.#state[index] = (Math.imul(1812433253, previous ^ (previous >>> 30)) + index) >>> 0;
    }
    this.#index = stateSize;
  }

  #initByArray(key: readonly number[]): void {
    this.#initGenRand(19650218);
    let stateIndex = 1;
    let keyIndex = 0;
    for (let remaining = Math.max(stateSize, key.length); remaining > 0; remaining -= 1) {
      const previous = this.#state[stateIndex - 1] ?? 0;
      const current = this.#state[stateIndex] ?? 0;
      this.#state[stateIndex] =
        ((current ^ Math.imul(previous ^ (previous >>> 30), 1664525)) + (key[keyIndex] ?? 0) + keyIndex) >>> 0;
      stateIndex += 1;
      keyIndex += 1;
      if (stateIndex >= stateSize) {
        this.#state[0] = this.#state[stateSize - 1] ?? 0;
        stateIndex = 1;
      }
      if (keyIndex >= key.length) keyIndex = 0;
    }
    for (let remaining = stateSize - 1; remaining > 0; remaining -= 1) {
      const previous = this.#state[stateIndex - 1] ?? 0;
      const current = this.#state[stateIndex] ?? 0;
      this.#state[stateIndex] =
        ((current ^ Math.imul(previous ^ (previous >>> 30), 1566083941)) - stateIndex) >>> 0;
      stateIndex += 1;
      if (stateIndex >= stateSize) {
        this.#state[0] = this.#state[stateSize - 1] ?? 0;
        stateIndex = 1;
      }
    }
    this.#state[0] = 0x80000000;
  }

  #twist(): void {
    for (let index = 0; index < stateSize; index += 1) {
      const combined = ((this.#state[index] ?? 0) & 0x80000000) | ((this.#state[(index + 1) % stateSize] ?? 0) & 0x7fffffff);
      let value = (this.#state[(index + period) % stateSize] ?? 0) ^ (combined >>> 1);
      if ((combined & 1) !== 0) value ^= 0x9908b0df;
      this.#state[index] = value >>> 0;
    }
    this.#index = 0;
  }

  #nextUint32(): number {
    if (this.#index >= stateSize) this.#twist();
    let value = this.#state[this.#index] ?? 0;
    this.#index += 1;
    value ^= value >>> 11;
    value ^= (value << 7) & 0x9d2c5680;
    value ^= (value << 15) & 0xefc60000;
    value ^= value >>> 18;
    return value >>> 0;
  }

  #getRandBits(bitCount: number): number {
    return this.#nextUint32() >>> (32 - bitCount);
  }

  randBelow(limit: number): number {
    const bitCount = Math.floor(Math.log2(limit)) + 1;
    let candidate = this.#getRandBits(bitCount);
    while (candidate >= limit) candidate = this.#getRandBits(bitCount);
    return candidate;
  }
}
