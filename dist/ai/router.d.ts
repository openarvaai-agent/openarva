import { type AiTaskCapability, type AiProvider } from './providers.js';
type ModelFactory = (modelName: string) => any;
interface OpenArvaRouterType {
    gemini: ModelFactory;
    openai: ModelFactory;
    anthropic: ModelFactory;
    groq: ModelFactory;
    grok: ModelFactory;
    kimi: ModelFactory;
    mistral: ModelFactory;
    local: ModelFactory;
    resolveTaskRoute: (capability: AiTaskCapability) => {
        capability: AiTaskCapability;
        provider: AiProvider;
        model: string;
    };
    selectModel: (taskType: string) => any;
}
export declare const OpenArvaRouter: OpenArvaRouterType;
export {};
