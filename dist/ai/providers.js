import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { getOpenArvaConfigPath as resolveOpenArvaConfigPath } from '../config/env.js';
import { isLocalOnlyMode, recordAudit, resolveEffectiveProvider, sanitizePromptForTransmission } from '../security/privacy.js';
import { retrieveRelevantMemory } from '../commands/learn.js';
export const AI_PROVIDER_OPTIONS = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic Claude' },
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'groq', label: 'Groq' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'ollama', label: 'Ollama / Local AI' },
    { value: 'local', label: 'Local AI (generic)' },
    { value: 'lmstudio', label: 'LM Studio' },
];
export const AI_MODEL_DEFAULTS = {
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    anthropic: ['claude-3-5-sonnet', 'claude-3-7-sonnet', 'claude-3-haiku'],
    gemini: ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    groq: ['llama-3.3-70b-versatile', 'mixtral-8x7b', 'gemma2-9b-it'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    ollama: ['llama3.1', 'qwen2.5-coder', 'deepseek-r1', 'mistral'],
    local: ['llama3.1', 'qwen2.5-coder', 'deepseek-r1'],
    lmstudio: ['local-model', 'qwen2.5-coder', 'deepseek-r1'],
};
export function normalizeProvider(provider) {
    const value = provider.trim().toLowerCase();
    switch (value) {
        case 'claude':
        case 'anthropic':
            return 'anthropic';
        case 'google':
        case 'gemini':
            return 'gemini';
        case 'openai':
            return 'openai';
        case 'groq':
            return 'groq';
        case 'deepseek':
        case 'deepseek-r1':
            return 'deepseek';
        case 'ollama':
        case 'local-ai':
            return 'ollama';
        case 'lmstudio':
        case 'lm studio':
            return 'lmstudio';
        case 'local':
            return 'local';
        default:
            return 'openai';
    }
}
function getEnvValue(key) {
    return process.env[key] || '';
}
export function getProviderConfig(provider, model) {
    const selectedProvider = normalizeProvider(provider || process.env.OPENARVA_PROVIDER || 'openai');
    const defaultModel = model || process.env.OPENARVA_MODEL || AI_MODEL_DEFAULTS[selectedProvider][0] || 'gpt-4o';
    switch (selectedProvider) {
        case 'anthropic':
            return {
                provider: 'anthropic',
                model: defaultModel,
                apiKey: getEnvValue('ANTHROPIC_API_KEY'),
            };
        case 'gemini':
            return {
                provider: 'gemini',
                model: defaultModel,
                apiKey: getEnvValue('GEMINI_API_KEY'),
            };
        case 'groq':
            return {
                provider: 'groq',
                model: defaultModel,
                apiKey: getEnvValue('GROQ_API_KEY'),
                baseUrl: getEnvValue('GROQ_BASE_URL') || 'https://api.groq.com/openai/v1',
            };
        case 'deepseek':
            return {
                provider: 'deepseek',
                model: defaultModel,
                apiKey: getEnvValue('DEEPSEEK_API_KEY'),
                baseUrl: getEnvValue('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com/v1',
            };
        case 'ollama':
            return {
                provider: 'ollama',
                model: defaultModel,
                baseUrl: getEnvValue('LOCAL_AI_BASE_URL') || 'http://localhost:11434/v1',
                apiKey: getEnvValue('OLLAMA_API_KEY') || 'ollama',
            };
        case 'local':
            return {
                provider: 'local',
                model: defaultModel,
                baseUrl: getEnvValue('LOCAL_AI_BASE_URL') || 'http://localhost:11434/v1',
                apiKey: getEnvValue('OLLAMA_API_KEY') || 'ollama',
            };
        case 'lmstudio':
            return {
                provider: 'lmstudio',
                model: defaultModel,
                baseUrl: getEnvValue('LMSTUDIO_BASE_URL') || 'http://localhost:1234/v1',
                apiKey: 'lmstudio',
            };
        case 'openai':
        default:
            return {
                provider: 'openai',
                model: defaultModel,
                apiKey: getEnvValue('OPENAI_API_KEY'),
                baseUrl: getEnvValue('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
            };
    }
}
function assertLocalModelEndpoint(provider, baseUrl) {
    if (!isLocalOnlyMode() || !['ollama', 'local', 'lmstudio'].includes(provider))
        return;
    if (!baseUrl)
        throw new Error(`Local-only mode requires a loopback endpoint for ${provider}.`);
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
        throw new Error(`Local-only mode requires a valid loopback endpoint for ${provider}.`);
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = hostname === 'localhost' || (isIP(hostname) === 4 && hostname.startsWith('127.')) || hostname === '::1';
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !loopback) {
        throw new Error(`Local-only mode blocks non-loopback model endpoint ${url.origin}.`);
    }
}
export function getOpenArvaConfigPath() {
    return resolveOpenArvaConfigPath();
}
export function loadOpenArvaConfig() {
    const configPath = getOpenArvaConfigPath();
    if (!existsSync(configPath)) {
        return {};
    }
    try {
        const raw = readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        const { apiKey: _apiKey, telegramBotToken: _telegramBotToken, ...safeConfig } = parsed;
        return safeConfig;
    }
    catch {
        return {};
    }
}
export function saveOpenArvaConfig(config) {
    const configPath = getOpenArvaConfigPath();
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });
    const { apiKey: _apiKey, ...safeConfig } = config;
    writeFileSync(configPath, JSON.stringify(safeConfig, null, 2), 'utf8');
}
export function createModelProvider(config) {
    const provider = normalizeProvider(config.provider || 'openai');
    const modelName = config.model || AI_MODEL_DEFAULTS[provider][0] || 'gpt-4o';
    if (isLocalOnlyMode()) {
        if (!['ollama', 'local', 'lmstudio'].includes(provider)) {
            throw new Error(`Local-only mode rejects model construction for cloud provider ${provider}.`);
        }
        assertLocalModelEndpoint(provider, config.baseUrl || getProviderConfig(provider).baseUrl);
    }
    switch (provider) {
        case 'anthropic':
            return createAnthropic({ apiKey: config.apiKey || getEnvValue('ANTHROPIC_API_KEY') })(modelName);
        case 'gemini':
            return createGoogleGenerativeAI({ apiKey: config.apiKey || getEnvValue('GEMINI_API_KEY') })(modelName);
        case 'groq':
            return createOpenAI({
                apiKey: config.apiKey || getEnvValue('GROQ_API_KEY'),
                baseURL: config.baseUrl || getEnvValue('GROQ_BASE_URL') || 'https://api.groq.com/openai/v1',
            })(modelName);
        case 'deepseek':
            return createOpenAI({
                apiKey: config.apiKey || getEnvValue('DEEPSEEK_API_KEY'),
                baseURL: config.baseUrl || getEnvValue('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com/v1',
            })(modelName);
        case 'ollama':
        case 'local':
            return createOpenAI({
                apiKey: config.apiKey || getEnvValue('OLLAMA_API_KEY') || 'ollama',
                baseURL: config.baseUrl || getEnvValue('LOCAL_AI_BASE_URL') || 'http://localhost:11434/v1',
            })(modelName);
        case 'lmstudio':
            return createOpenAI({
                apiKey: config.apiKey || 'lmstudio',
                baseURL: config.baseUrl || getEnvValue('LMSTUDIO_BASE_URL') || 'http://localhost:1234/v1',
            })(modelName);
        case 'openai':
        default:
            return createOpenAI({
                apiKey: config.apiKey || getEnvValue('OPENAI_API_KEY'),
                baseURL: config.baseUrl || getEnvValue('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
            })(modelName);
    }
}
export function getProviderCandidates(primaryProvider, localOnly = isLocalOnlyMode()) {
    if (localOnly) {
        const provider = normalizeProvider(primaryProvider);
        if (!['ollama', 'local', 'lmstudio'].includes(provider)) {
            throw new Error(`Local-only mode rejects non-local provider ${provider}.`);
        }
        return [provider];
    }
    return [primaryProvider, 'openai', 'anthropic', 'gemini', 'groq', 'deepseek', 'ollama', 'local', 'lmstudio']
        .map(normalizeProvider)
        .filter((value, index, array) => array.indexOf(value) === index);
}
export async function routeAiCompletion(prompt, providerOverride, modelOverride) {
    const persisted = loadOpenArvaConfig();
    const localOnly = isLocalOnlyMode();
    const effectiveProvider = resolveEffectiveProvider(providerOverride || persisted.provider || process.env.OPENARVA_PROVIDER);
    const relevantMemory = retrieveRelevantMemory(prompt, 3);
    const memoryContext = relevantMemory.length
        ? `\n\n[LOCAL MEMORY CONTEXT]\n${relevantMemory.map((item) => `- ${item.source}: ${item.text.substring(0, 600)}`).join('\n')}\n[/LOCAL MEMORY CONTEXT]`
        : '';
    const sanitizedPrompt = sanitizePromptForTransmission(`${prompt}${memoryContext}`, effectiveProvider);
    const defaultConfig = getProviderConfig(effectiveProvider, modelOverride || persisted.model || process.env.OPENARVA_MODEL);
    const candidateProviders = getProviderCandidates(effectiveProvider, localOnly);
    let lastError;
    const preferredProvider = normalizeProvider(effectiveProvider);
    const storedProvider = normalizeProvider(persisted.provider || process.env.OPENARVA_PROVIDER || 'openai');
    for (const candidate of candidateProviders) {
        try {
            recordAudit('ai_route_attempt', `Attempting provider ${candidate} for prompt`, process.env.OPENARVA_USER || persisted.privacy?.userIdentity || 'unknown-user');
            const candidateConfig = getProviderConfig(candidate);
            const isPreferredProvider = candidate === preferredProvider;
            const useStoredCredentials = isPreferredProvider && candidate === storedProvider;
            const modelConfig = {
                provider: candidate,
                model: isPreferredProvider ? modelOverride || persisted.model || defaultConfig.model : candidateConfig.model,
                apiKey: candidateConfig.apiKey,
                baseUrl: useStoredCredentials ? persisted.baseUrl || candidateConfig.baseUrl : candidateConfig.baseUrl,
            };
            assertLocalModelEndpoint(candidate, modelConfig.baseUrl);
            const model = createModelProvider(modelConfig);
            const result = await generateText({
                model,
                prompt: sanitizedPrompt,
            });
            recordAudit('ai_route_success', `Resolved prompt via ${candidate}`, process.env.OPENARVA_USER || persisted.privacy?.userIdentity || 'unknown-user');
            return result.text;
        }
        catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            recordAudit('ai_route_failure', `Provider ${candidate} failed: ${message}`, process.env.OPENARVA_USER || persisted.privacy?.userIdentity || 'unknown-user');
            if (/api key|unauthorized|401|403|429|rate limit|ECONNREFUSED|fetch failed|ENOTFOUND/i.test(message)) {
                continue;
            }
        }
    }
    const errorMessage = lastError instanceof Error ? lastError.message : 'Unknown provider failure';
    if (localOnly) {
        throw new Error(`Local-only mode is enabled and local provider ${effectiveProvider} failed. No cloud fallback was attempted. Last error: ${errorMessage}`);
    }
    if (/api key|unauthorized|401|403|429|rate limit|ECONNREFUSED|fetch failed|ENOTFOUND/i.test(errorMessage)) {
        return `OpenArva demo mode is active. The configured AI provider is unavailable right now, so this is a safe dry-run preview. Prompt received: "${sanitizedPrompt}"`;
    }
    throw new Error(lastError instanceof Error
        ? `All AI providers failed while routing the request. Last error: ${lastError.message}`
        : 'All AI providers failed while routing the request.');
}
export function getModelProvider(providerName, modelName) {
    const provider = normalizeProvider(providerName);
    if (isLocalOnlyMode() && !['ollama', 'local', 'lmstudio'].includes(provider)) {
        throw new Error(`Local-only mode rejects model construction for cloud provider ${provider}.`);
    }
    return createModelProvider({
        provider,
        model: modelName,
        apiKey: process.env[`${provider.toUpperCase()}_API_KEY`] || '',
    });
}
const capabilityModels = {
    fast: {
        openai: 'gpt-4o-mini', anthropic: 'claude-3-haiku-20240307', gemini: 'gemini-2.0-flash',
        groq: 'llama-3.3-70b-versatile', deepseek: 'deepseek-chat', ollama: 'llama3.2:3b',
        local: 'llama3.1', lmstudio: 'local-model',
    },
    reasoning: {
        openai: 'gpt-4.1', anthropic: 'claude-3-7-sonnet-20250219', gemini: 'gemini-2.5-pro',
        groq: 'llama-3.3-70b-versatile', deepseek: 'deepseek-reasoner', ollama: 'deepseek-r1',
        local: 'deepseek-r1', lmstudio: 'local-model',
    },
    coding: {
        openai: 'gpt-4.1', anthropic: 'claude-3-7-sonnet-20250219', gemini: 'gemini-2.5-pro',
        groq: 'llama-3.3-70b-versatile', deepseek: 'deepseek-chat', ollama: 'qwen2.5-coder',
        local: 'qwen2.5-coder', lmstudio: 'qwen2.5-coder',
    },
    vision: {
        openai: 'gpt-4o', anthropic: 'claude-3-7-sonnet-20250219', gemini: 'gemini-2.5-pro',
    },
    research: {
        openai: 'gpt-4.1', anthropic: 'claude-3-7-sonnet-20250219', gemini: 'gemini-2.5-pro',
        groq: 'llama-3.3-70b-versatile', deepseek: 'deepseek-reasoner', ollama: 'deepseek-r1',
        local: 'deepseek-r1', lmstudio: 'local-model',
    },
};
export function resolveTaskModelRoute(capability) {
    const persisted = loadOpenArvaConfig();
    const localOnly = isLocalOnlyMode();
    const envPrefix = `OPENARVA_${capability.toUpperCase()}`;
    const configuredProvider = normalizeProvider(persisted.provider || process.env.OPENARVA_PROVIDER || 'openai');
    const providerOverride = process.env[`${envPrefix}_PROVIDER`];
    let provider = normalizeProvider(providerOverride || configuredProvider);
    if (localOnly) {
        const localProvider = normalizeProvider(process.env.LOCAL_AI_PROVIDER || 'ollama');
        if (!['ollama', 'local', 'lmstudio'].includes(localProvider)) {
            throw new Error(`Local-only mode requires a local provider; ${localProvider} is not local.`);
        }
        if (providerOverride && normalizeProvider(providerOverride) !== localProvider) {
            throw new Error(`Local-only mode rejects ${providerOverride} for ${capability}; configure ${localProvider} or remove the cloud override.`);
        }
        provider = localProvider;
    }
    if (capability === 'vision' && !capabilityModels.vision[provider]) {
        if (localOnly) {
            const localVisionModel = process.env.OPENARVA_VISION_MODEL;
            if (!localVisionModel)
                throw new Error('Local-only vision requires OPENARVA_VISION_MODEL. Cloud image transmission is blocked.');
            return { capability, provider, model: localVisionModel };
        }
        if (providerOverride)
            throw new Error(`Provider ${provider} does not support the vision capability.`);
        const availableVisionProvider = ['gemini', 'openai', 'anthropic'].find((candidate) => {
            const candidateConfig = getProviderConfig(candidate);
            return Boolean(candidateConfig.apiKey);
        });
        if (availableVisionProvider)
            provider = availableVisionProvider;
        else
            throw new Error('No vision-capable provider is configured. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.');
    }
    const configuredModel = process.env[`${envPrefix}_MODEL`];
    const model = configuredModel || capabilityModels[capability][provider] || persisted.model || getProviderConfig(provider).model;
    return { capability, provider, model };
}
export async function routeAiVisionCompletion(prompt, image, mimeType, signal) {
    if (isLocalOnlyMode() && !['ollama', 'local', 'lmstudio'].includes(normalizeProvider(process.env.LOCAL_AI_PROVIDER || 'ollama'))) {
        throw new Error('Local-only mode blocks image transmission to cloud providers.');
    }
    const route = resolveTaskModelRoute('vision');
    const persisted = loadOpenArvaConfig();
    const configuredProvider = normalizeProvider(persisted.provider || process.env.OPENARVA_PROVIDER || 'openai');
    const providerConfig = getProviderConfig(route.provider, route.model);
    const useStoredCredentials = route.provider === configuredProvider;
    const modelConfig = {
        ...providerConfig,
        apiKey: providerConfig.apiKey,
        baseUrl: useStoredCredentials ? persisted.baseUrl || providerConfig.baseUrl : providerConfig.baseUrl,
    };
    assertLocalModelEndpoint(route.provider, modelConfig.baseUrl);
    const model = createModelProvider(modelConfig);
    const user = process.env.OPENARVA_USER || persisted.privacy?.userIdentity || 'unknown-user';
    const sanitizedPrompt = sanitizePromptForTransmission(prompt, route.provider);
    recordAudit('ai_vision_route_attempt', `Analyzing image with ${route.provider}/${route.model}`, user);
    const result = await generateText({
        model,
        abortSignal: signal,
        messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: sanitizedPrompt },
                    { type: 'image', image, mimeType },
                ],
            }],
    });
    recordAudit('ai_vision_route_success', `Analyzed image with ${route.provider}/${route.model}`, user);
    return { text: result.text, route };
}
