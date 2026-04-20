let extractorSingleton: any = null;

const l2Normalize = (values: Float32Array) => {
  let norm = 0;
  for (let i = 0; i < values.length; i += 1) {
    norm += values[i] * values[i];
  }
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = values[i] / norm;
  }
  return out;
};

const toFloat32 = (data: any) => {
  if (data instanceof Float32Array) return data;
  if (Array.isArray(data)) return Float32Array.from(data.map((v) => Number(v) || 0));
  if (data?.data && Array.isArray(data.data)) return Float32Array.from(data.data.map((v) => Number(v) || 0));
  return new Float32Array(0);
};

const ensureExtractor = async () => {
  if (extractorSingleton) return extractorSingleton;
  const transformers = await import('@xenova/transformers');
  extractorSingleton = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return extractorSingleton;
};

export const embed = async (text: string) => {
  const extractor = await ensureExtractor();
  const output = await extractor(String(text || ''), { pooling: 'mean', normalize: false });
  const raw = toFloat32(output?.data ?? output);
  return l2Normalize(raw);
};

export const cosineSimilarity = (a: Float32Array, b: Float32Array) => {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
};

export const float32FromBlob = (value: any) => {
  if (!value) return new Float32Array(0);
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer) return new Float32Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 4));
  }
  if (Buffer.isBuffer(value)) {
    return new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 4));
  }
  return new Float32Array(0);
};
