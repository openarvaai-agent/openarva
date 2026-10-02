// These providers are optional peer dependencies in deployments that only use
// the local engine. Keep the router type-checkable in those deployments.
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getModelProvider, resolveTaskModelRoute } from './providers.js';
import { isLocalOnlyMode } from '../security/privacy.js';
function cloudModelFactory(provider, factory) {
    return (modelName) => {
        if (isLocalOnlyMode())
            throw new Error(`Local-only mode blocks direct ${provider} model access.`);
        return factory(modelName);
    };
}
const geminiEngine = createOpenAI({
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: process.env.GEMINI_API_KEY,
});
const openaiEngine = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropicEngine = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const groqEngine = createOpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY });
const grokEngine = createOpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: process.env.XAI_API_KEY });
const kimiEngine = createOpenAI({ baseURL: 'https://api.moonshot.cn/v1', apiKey: process.env.KIMI_API_KEY });
const mistralEngine = createOpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: process.env.MISTRAL_API_KEY });
export const OpenArvaRouter = {
    gemini: cloudModelFactory('Gemini', geminiEngine),
    openai: cloudModelFactory('OpenAI', openaiEngine),
    anthropic: cloudModelFactory('Anthropic', anthropicEngine),
    groq: cloudModelFactory('Groq', groqEngine),
    grok: cloudModelFactory('Grok', grokEngine),
    kimi: cloudModelFactory('Kimi', kimiEngine),
    mistral: cloudModelFactory('Mistral', mistralEngine),
    local: (modelName) => getModelProvider('ollama', modelName),
    resolveTaskRoute(capability) {
        return resolveTaskModelRoute(capability);
    },
    selectModel(taskType) {
        let capability;
        switch (taskType) {
            case 'coding':
            case 'software_engineering':
                capability = 'coding';
                break;
            case 'deep_reasoning':
            case 'complex_analysis':
            case 'engineering':
                capability = 'reasoning';
                break;
            case 'accounting':
            case 'financial_analysis':
                capability = 'reasoning';
                break;
            case 'medicine':
            case 'medical_research':
                capability = 'research';
                break;
            case 'multilingual_translation':
            case 'language_processing':
                capability = 'fast';
                break;
            case 'agriculture':
            case 'agriculture_research':
                capability = 'research';
                break;
            case 'bureaucracy_documents':
            case 'documents':
            case 'legal':
                capability = 'reasoning';
                break;
            case 'research':
                capability = 'research';
                break;
            case 'vision':
            case 'image':
            case 'image_analysis':
                capability = 'vision';
                break;
            default:
                capability = 'fast';
        }
        const route = this.resolveTaskRoute(capability);
        return getModelProvider(route.provider, route.model);
    }
};
