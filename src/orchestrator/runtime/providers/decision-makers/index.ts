import { ApolloDecisionMakerProvider } from './apollo.js';
import { HunterDecisionMakerProvider } from './hunter.js';
import type {
  DecisionMakerProvider,
  DecisionMakerProviderFactory,
  DecisionMakerProviderFactoryContext,
} from './types.js';

export type {
  DecisionMakerCandidate,
  DecisionMakerProvider,
  DecisionMakerProviderFactory,
  DecisionMakerProviderFactoryContext,
  DecisionMakerRevealInput,
  DecisionMakerRevealResult,
  DecisionMakerSearchInput,
  DecisionMakerSearchResult,
} from './types.js';

export const DEFAULT_DECISION_MAKER_PROVIDER = 'hunter';

const builtInFactories: Record<string, DecisionMakerProviderFactory> = {
  hunter: {
    requires_mcp: true,
    create: (context) => new HunterDecisionMakerProvider(context),
  },
  apollo: {
    requires_mcp: false,
    create: () => new ApolloDecisionMakerProvider(),
  },
};

const normalizedProviderId = (value: string | undefined) => (
  String(value || DEFAULT_DECISION_MAKER_PROVIDER).trim().toLowerCase()
    || DEFAULT_DECISION_MAKER_PROVIDER
);

export const resolveDecisionMakerProvider = ({
  provider,
  context = {},
  factories = builtInFactories,
}: {
  provider?: string;
  context?: DecisionMakerProviderFactoryContext;
  factories?: Record<string, DecisionMakerProviderFactory>;
}): DecisionMakerProvider => {
  const id = normalizedProviderId(provider);
  const factory = factories[id];
  if (!factory) throw new Error(`Unknown decision-maker provider "${id}".`);
  return factory.create(context);
};

export const decisionMakerProviderNeedsMcp = ({
  provider,
  factories = builtInFactories,
}: {
  provider?: string;
  factories?: Record<string, DecisionMakerProviderFactory>;
}) => {
  const id = normalizedProviderId(provider);
  const factory = factories[id];
  if (!factory) throw new Error(`Unknown decision-maker provider "${id}".`);
  return factory.requires_mcp;
};
