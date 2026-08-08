import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export const representativePipelineRoot = root;
export const representativePipelineYaml = join(root, 'outbound.yaml');
export const representativeTaxonomy = join(root, 'build/registries/vertical-taxonomy.json');
export const representativeDiagnostics = join(root, 'build/registries/diagnostic-families.json');
export const representativeProofLibrary = join(root, 'build/assets/proof-library.json');
