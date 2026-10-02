import { type LanguageModel } from 'ai';
export type AiProvider = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'deepseek' | 'ollama' | 'local' | 'lmstudio';
export interface OpenArvaProviderConfig {
    provider: AiProvider;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    enabled?: boolean;
    privacy?: {
        localOnly?: boolean;
        redactPii?: boolean;
        auditLog?: boolean;
        userIdentity?: string;
    };
}
export interface OpenArvaRuntimeConfig {
    provider: AiProvider;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    prompt?: string;
}
export declare const AI_PROVIDER_OPTIONS: Array<{
    value: AiProvider;
    label: string;
}>;
export declare const AI_MODEL_DEFAULTS: Record<AiProvider, string[]>;
export declare function normalizeProvider(provider: string): AiProvider;
export declare function getProviderConfig(provider?: string, model?: string): OpenArvaProviderConfig;
export declare function getOpenArvaConfigPath(): string;
export declare function loadOpenArvaConfig(): Partial<OpenArvaProviderConfig>;
export declare function saveOpenArvaConfig(config: OpenArvaProviderConfig): void;
export declare function createModelProvider(config: OpenArvaProviderConfig): LanguageModel;
export declare function getProviderCandidates(primaryProvider: string, localOnly?: boolean): AiProvider[];
export declare function routeAiCompletion(prompt: string, providerOverride?: string, modelOverride?: string): Promise<string>;
export declare function getModelProvider(providerName: string, modelName: string): LanguageModel;
export type AiTaskCapability = 'fast' | 'reasoning' | 'coding' | 'vision' | 'research';
export interface AiTaskModelRoute {
    capability: AiTaskCapability;
    provider: AiProvider;
    model: string;
}
export declare function resolveTaskModelRoute(capability: AiTaskCapability): AiTaskModelRoute;
export declare function routeAiVisionCompletion(prompt: string, image: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<{
    text: string;
    route: AiTaskModelRoute;
}>;
