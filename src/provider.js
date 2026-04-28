import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ora from 'ora';

import { getAuthRecord, runAuthFlow, saveAuthRecord } from './auth.js';

const GEMINI_MODELS = [
    { name: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
    { name: 'Gemini 2.5 Pro (needs paid api)', value: 'gemini-2.5-pro' },
    { name: 'Gemini 3 Flash', value: 'gemini-3-flash-preview' },
    { name: 'Gemini 3.1 Flash Lite (fast responses)', value: 'gemini-3.1-flash-lite-preview' },
    { name: 'Gemini 3.1 Pro (needs paid api)', value: 'gemini-3.1-pro-preview' }
];

const AUTO_MODEL_DESCRIPTIONS = {
    'gemini-2.5-flash': 'Fast Gemini (2024). Best for very light or simple work.',
    'gemini-2.5-pro': 'More capable Gemini (2024). Better for deeper reasoning. Requires paid access.',
    'gemini-3-flash-preview': 'Latest Gemini Flash (2025). Best general default for normal tasks.',
    'gemini-3.1-flash-lite-preview': 'Fastest Gemini option. Best for quick low-complexity tasks.',
    'gemini-3.1-pro-preview': 'Most capable Gemini (2025). Best for the most demanding tasks. Requires paid access.'
};

const GEMINI_AUTO_FALLBACK_MODEL = 'gemini-3-flash-preview';
const GEMINI_PAID_TIER_PROBE_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_AUTO_FREE_ROUTER_MODEL = 'gemini-2.5-flash';
const GEMINI_AUTO_PAID_ROUTER_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_AUTO_PRO_MODEL_IDS = [
    'gemini-2.5-pro',
    'gemini-3.1-pro-preview'
];
const GEMINI_AUTO_FREE_TIER_MODEL_IDS = new Set([
    'gemini-2.5-flash',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview'
]);
const SPINNER_VERBS = [
    'Working', 'Thinking', 'Processing', 'Loading', 'Running',
    'Building', 'Computing', 'Executing', 'Preparing', 'Finishing',
    'Compiling', 'Deploying', 'Refactoring', 'Debugging', 'Parsing',
    'Optimizing', 'Indexing', 'Caching', 'Rendering', 'Transpiling',
    'Bundling', 'Linting', 'Patching', 'Scaffolding', 'Bananing', 'Coding'
];
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';
const CODE_ASSIST_FREE_TIER_ID = 'free-tier';
const GEMINI_CLI_VERSION = '0.39.1';

let bananaRuntimePromise = null;

function getFallbackSpinnerText(provider) {
    if (Math.random() < 0.5 && provider?.toLowerCase() === 'gemini') {
        return 'Gemming...';
    }

    const verb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
    return `${verb}...`;
}

function sanitizeSchemaForStrictAPIs(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const sanitized = Array.isArray(schema) ? [] : {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'additionalProperties' || key === '$schema' || key === 'const') {
            continue;
        }

        sanitized[key] = typeof value === 'object' && value !== null
            ? sanitizeSchemaForStrictAPIs(value)
            : value;
    }

    return sanitized;
}

function geminiMessagesToAutoRouterHistory(messages, max = 7) {
    if (!messages?.length) {
        return '';
    }

    const recent = messages.slice(-max);
    return recent.map((message) => {
        const label = message.role === 'model' ? '[assistant]' : `[${message.role}]`;
        const body = (message.parts || []).map((part) => {
            if (part.text) {
                return part.text;
            }
            if (part.functionCall) {
                return `[tool ${part.functionCall.name}]`;
            }
            if (part.functionResponse) {
                return '[tool result]';
            }
            return '';
        }).join(' ');

        const trimmed = body.trim();
        const truncated = trimmed.length > 1500 ? `${trimmed.slice(0, 1500)}…` : trimmed;
        return `${label} ${truncated}`;
    }).join('\n\n');
}

function buildRoutingPrompt(models, currentUserMessage, historyText = '') {
    const modelList = models.map(({ id, description }) => `- ${id}: ${description}`).join('\n');
    const historyBlock = historyText.trim()
        ? `\n---\nConversation history (background only):\n${historyText.trim()}\n---\n`
        : '';

    return `You are a model router for Banana Code. Choose exactly one Gemini model for the next response.\n\nCRITICAL RULES:\n- Output JSON only.\n- Do not answer the user.\n- Use conversation history only as context.\n- Pick the cheapest model that can adequately handle the current request.\n\nAvailable models:\n${modelList}\n${historyBlock}\nCurrent user message:\n${currentUserMessage}\n\nRespond only with valid JSON: {"model":"<exact_model_id>","reason":"<one brief sentence>"}`;
}

function parseRoutingResponse(text) {
    try {
        const match = text.match(/\{[\s\S]*?\}/);
        if (!match) {
            return null;
        }

        const parsed = JSON.parse(match[0]);
        if (typeof parsed.model === 'string' && typeof parsed.reason === 'string') {
            return parsed;
        }
    } catch {}

    return null;
}

function resolveBananaRoot() {
    const candidates = new Set();

    if (process.env.BANANA_CODE_ROOT) {
        candidates.add(process.env.BANANA_CODE_ROOT);
    }

    if (process.argv[1]) {
        const entryDir = path.dirname(path.resolve(process.argv[1]));
        candidates.add(path.resolve(entryDir, '..'));
        candidates.add(path.resolve(entryDir, '..', '..'));
        candidates.add(entryDir);
    }

    try {
        const resolver = createRequire(process.argv[1] || import.meta.url);
        const pkgJson = resolver.resolve('@banaxi/banana-code/package.json');
        candidates.add(path.dirname(pkgJson));
    } catch {}

    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, 'src', 'tools', 'registry.js')) && existsSync(path.join(candidate, 'src', 'prompt.js'))) {
            return candidate;
        }
    }

    return null;
}

async function loadBananaRuntime() {
    if (bananaRuntimePromise) {
        return bananaRuntimePromise;
    }

    bananaRuntimePromise = (async () => {
        const bananaRoot = resolveBananaRoot();
        if (!bananaRoot) {
            return {
                getAvailableTools: () => [],
                executeTool: async () => 'Banana Code tool registry is unavailable outside the Banana runtime.',
                sanitizeSchemaForStrictAPIs,
                getSystemPrompt: () => 'You are Banana Code, a terminal-based AI coding assistant.',
                getRandomSpinnerText: getFallbackSpinnerText,
                printMarkdown: (text) => process.stdout.write(text)
            };
        }

        const registryModule = await import(pathToFileURL(path.join(bananaRoot, 'src', 'tools', 'registry.js')).href);
        const promptModule = await import(pathToFileURL(path.join(bananaRoot, 'src', 'prompt.js')).href);
        const spinnerModule = await import(pathToFileURL(path.join(bananaRoot, 'src', 'utils', 'spinner.js')).href);
        const markdownModule = await import(pathToFileURL(path.join(bananaRoot, 'src', 'utils', 'markdown.js')).href);

        return {
            getAvailableTools: registryModule.getAvailableTools,
            executeTool: registryModule.executeTool,
            sanitizeSchemaForStrictAPIs: registryModule.sanitizeSchemaForStrictAPIs || sanitizeSchemaForStrictAPIs,
            getSystemPrompt: promptModule.getSystemPrompt,
            getRandomSpinnerText: spinnerModule.getRandomSpinnerText || getFallbackSpinnerText,
            printMarkdown: markdownModule.printMarkdown || ((text) => process.stdout.write(text))
        };
    })();

    return bananaRuntimePromise;
}

function createActivityRequestId() {
    return Math.random().toString(36).substring(7);
}

function buildGeminiCliUserAgent(model) {
    const modelSegment = model?.trim() || 'gemini-code-assist';
    return `GeminiCLI/${GEMINI_CLI_VERSION}/${modelSegment} (${process.platform}; ${process.arch})`;
}

function normalizeProjectId(value) {
    if (!value) {
        return undefined;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || undefined;
    }

    if (typeof value === 'object' && typeof value.id === 'string') {
        const trimmed = value.id.trim();
        return trimmed || undefined;
    }

    return undefined;
}

function pickOnboardTier(allowedTiers = []) {
    return allowedTiers.find((tier) => tier?.isDefault) || allowedTiers[0] || { id: 'legacy-tier' };
}

function buildCodeAssistMetadata(projectId, includeDuetProject = true) {
    const metadata = {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
    };

    if (projectId && includeDuetProject) {
        metadata.duetProject = projectId;
    }

    return metadata;
}

function addThoughtSignaturesToFunctionCalls(contents) {
    if (!Array.isArray(contents)) {
        return;
    }

    for (const content of contents) {
        if (!content || typeof content !== 'object' || !Array.isArray(content.parts)) {
            continue;
        }

        for (const part of content.parts) {
            if (part?.functionCall && !part.thoughtSignature) {
                part.thoughtSignature = 'skip_thought_signature_validator';
            }
        }
    }
}

function unwrapCodeAssistResponse(body) {
    if (body && typeof body === 'object' && body.response && typeof body.response === 'object') {
        return body.response;
    }

    return body;
}

export class GeminiOAuthProvider {
    constructor(config) {
        this.config = config;
        this.modelName = config.model || 'gemini-2.5-flash';
        this.messages = [];
        this.systemPrompt = '';
        this.tools = [];
        this._geminiModelAvailabilityCache = new Map();
        this._runtime = null;
        this._runtimePromise = null;
        this._runtimeLoadError = null;

        this.ensureRuntime().catch((error) => {
            this._runtimeLoadError = error;
        });
    }

    static async getModels() {
        return [
            { name: `${chalk.cyan('⚡ Auto Mode')}${chalk.gray(' (AI picks the best model per prompt)')}`, value: 'auto' },
            ...GEMINI_MODELS
        ];
    }

    static async setup(config = {}) {
        const nextConfig = { ...config, provider: 'gemini-oauth' };
        nextConfig.model = await select({
            message: 'Select a Gemini model:',
            choices: await GeminiOAuthProvider.getModels()
        });

        console.log(chalk.cyan('\nLaunching Gemini OAuth sign-in...'));
        await runAuthFlow();
        return nextConfig;
    }

    async ensureRuntime() {
        if (this._runtimePromise) {
            return this._runtimePromise;
        }

        this._runtimePromise = (async () => {
            this._runtime = await loadBananaRuntime();
            this.tools = this._runtime.getAvailableTools(this.config).map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: this._runtime.sanitizeSchemaForStrictAPIs(tool.parameters)
            }));

            if (!this.systemPrompt) {
                this.systemPrompt = this._runtime.getSystemPrompt(this.config);
            }
        })();

        return this._runtimePromise;
    }

    updateSystemPrompt(newPrompt) {
        this.systemPrompt = newPrompt;
    }

    async getAuthState() {
        try {
            return await getAuthRecord();
        } catch (error) {
            const message = 'Failed to obtain a Gemini OAuth token. Run /gemini-oauth-login and try again.';
            if (!this.config.isApiMode) {
                console.error(chalk.red(message));
            }
            throw new Error(error instanceof Error ? `${message} ${error.message}` : message);
        }
    }

    buildCodeAssistHeaders(token, model, streaming = false) {
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': buildGeminiCliUserAgent(model),
            'x-activity-request-id': createActivityRequestId()
        };

        if (streaming) {
            headers.Accept = 'text/event-stream';
        }

        return headers;
    }

    async loadCodeAssistPayload(token, projectId, model) {
        const payload = { metadata: buildCodeAssistMetadata(projectId) };
        if (projectId) {
            payload.cloudaicompanionProject = projectId;
        }

        const response = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:loadCodeAssist`, {
            method: 'POST',
            headers: this.buildCodeAssistHeaders(token, model),
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(text || `HTTP ${response.status}`);
        }

        return await response.json();
    }

    async onboardCodeAssistProject(token, projectId, tierId, model, attempts = 10, delayMs = 5000) {
        const isFreeTier = tierId === CODE_ASSIST_FREE_TIER_ID;
        const payload = {
            tierId,
            metadata: buildCodeAssistMetadata(projectId, !isFreeTier)
        };

        if (!isFreeTier) {
            if (!projectId) {
                throw new Error('This Gemini OAuth account needs a Google Cloud project. Set GOOGLE_CLOUD_PROJECT and try again.');
            }
            payload.cloudaicompanionProject = projectId;
        }

        const baseUrl = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}`;
        let response = await fetch(`${baseUrl}:onboardUser`, {
            method: 'POST',
            headers: this.buildCodeAssistHeaders(token, model),
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(text || `HTTP ${response.status}`);
        }

        let data = await response.json();
        if (!data.done && data.name) {
            for (let attempt = 0; attempt < attempts; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                response = await fetch(`${baseUrl}/${data.name}`, {
                    method: 'GET',
                    headers: this.buildCodeAssistHeaders(token, model)
                });
                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    throw new Error(text || `HTTP ${response.status}`);
                }
                data = await response.json();
                if (data.done) {
                    break;
                }
            }
        }

        return data.response?.cloudaicompanionProject?.id || projectId;
    }

    async resolveProjectId(auth, model) {
        const configuredProjectId = normalizeProjectId(
            this.config.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID
        );

        if (!configuredProjectId && (auth.projectId || auth.managedProjectId)) {
            return auth.projectId || auth.managedProjectId;
        }

        const payload = await this.loadCodeAssistPayload(auth.access, configuredProjectId, model);
        const managedProjectId = normalizeProjectId(payload?.cloudaicompanionProject);
        if (managedProjectId) {
            if (auth.projectId !== configuredProjectId || auth.managedProjectId !== managedProjectId) {
                await saveAuthRecord({
                    ...auth,
                    projectId: configuredProjectId,
                    managedProjectId
                });
            }
            return managedProjectId;
        }

        const tier = pickOnboardTier(payload?.allowedTiers || []);
        const tierId = tier.id || 'legacy-tier';
        const onboardedProjectId = await this.onboardCodeAssistProject(auth.access, configuredProjectId, tierId, model);

        if (onboardedProjectId) {
            await saveAuthRecord({
                ...auth,
                projectId: configuredProjectId,
                managedProjectId: onboardedProjectId
            });
            return onboardedProjectId;
        }

        if (configuredProjectId) {
            return configuredProjectId;
        }

        throw new Error('Gemini OAuth could not resolve a Code Assist project for this account. If your Google account requires a Google Cloud project, set GOOGLE_CLOUD_PROJECT and try again.');
    }

    wrapCodeAssistRequest(projectId, model, requestPayload) {
        const request = JSON.parse(JSON.stringify(requestPayload));
        addThoughtSignaturesToFunctionCalls(request.contents);

        return {
            project: projectId,
            model,
            user_prompt_id: randomUUID(),
            request
        };
    }

    async requestCodeAssist(action, model, requestPayload, { streaming = false } = {}) {
        const auth = await this.getAuthState();
        const projectId = await this.resolveProjectId(auth, model);
        const response = await fetch(
            `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${action}${streaming ? '?alt=sse' : ''}`,
            {
                method: 'POST',
                headers: this.buildCodeAssistHeaders(auth.access, model, streaming),
                body: JSON.stringify(this.wrapCodeAssistRequest(projectId, model, requestPayload))
            }
        );

        return response;
    }

    markModelUnavailable(model) {
        if (GEMINI_AUTO_PRO_MODEL_IDS.includes(model)) {
            this._geminiModelAvailabilityCache.set(model, false);
        }
    }

    async probeModelAvailability(model) {
        if (this._geminiModelAvailabilityCache.has(model)) {
            return this._geminiModelAvailabilityCache.get(model) === true;
        }

        try {
            const response = await this.requestCodeAssist('generateContent', model, {
                contents: [{ parts: [{ text: 'hi' }] }],
                generationConfig: { maxOutputTokens: 1 }
            });

            const data = unwrapCodeAssistResponse(await response.json());
            if (this.config.debug) {
                const preview = JSON.stringify(data);
                console.error(chalk.gray(`\n[DEBUG] Gemini model probe ${model} HTTP ${response.status}: ${preview.length > 800 ? `${preview.slice(0, 800)}…` : preview}`));
            }

            const available = response.ok && !!data.candidates?.[0];
            this._geminiModelAvailabilityCache.set(model, available);
            return available;
        } catch (error) {
            if (this.config.debug) {
                console.error(chalk.yellow(`\n[DEBUG] Gemini model probe error for ${model}: ${error.message}`));
            }
            this._geminiModelAvailabilityCache.set(model, false);
            return false;
        }
    }

    async getAutoRoutableModels() {
        const routableModels = GEMINI_MODELS.filter((model) => !GEMINI_AUTO_PRO_MODEL_IDS.includes(model.value));

        const probeResults = await Promise.all(
            GEMINI_AUTO_PRO_MODEL_IDS.map(async (modelId) => ({
                modelId,
                available: await this.probeModelAvailability(modelId)
            }))
        );

        for (const result of probeResults) {
            if (result.available) {
                const model = GEMINI_MODELS.find((entry) => entry.value === result.modelId);
                if (model) {
                    routableModels.push(model);
                }
            }
        }

        return routableModels;
    }

    async probeGeminiPaidTierForAuto() {
        const proAvailability = await Promise.all(
            GEMINI_AUTO_PRO_MODEL_IDS.map((model) => this.probeModelAvailability(model))
        );
        return proAvailability.some(Boolean);
    }

    async autoRoute(message) {
        const historyText = geminiMessagesToAutoRouterHistory(this.messages || []);
        const modelSource = await this.getAutoRoutableModels();
        const paidTier = modelSource.some((model) => GEMINI_AUTO_PRO_MODEL_IDS.includes(model.value));
        const models = modelSource.map((model) => ({
            id: model.value,
            description: AUTO_MODEL_DESCRIPTIONS[model.value] || model.name
        }));
        const routerModel = paidTier ? GEMINI_AUTO_PAID_ROUTER_MODEL : GEMINI_AUTO_FREE_ROUTER_MODEL;
        const prompt = buildRoutingPrompt(models, message, historyText);

        try {
            const response = await this.requestCodeAssist('generateContent', routerModel, {
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
            const data = unwrapCodeAssistResponse(await response.json());

            if (!response.ok) {
                if (this.config.debug) {
                    console.error(chalk.yellow(`\n[DEBUG] Gemini auto-route HTTP ${response.status}: ${JSON.stringify(data)}`));
                }
                return { model: GEMINI_AUTO_FALLBACK_MODEL, reason: 'Auto-routing failed, using fallback model.' };
            }

            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const result = parseRoutingResponse(text);
            if (result && models.some((model) => model.id === result.model)) {
                return result;
            }

            if (this.config.debug) {
                console.error(chalk.yellow(`\n[DEBUG] Gemini auto-route parse failed. Extracted text: ${JSON.stringify(text)}`));
            }
        } catch (error) {
            if (this.config.debug) {
                console.error(chalk.yellow(`\n[DEBUG] Gemini auto-route error: ${error.message}`));
            }
        }

        return { model: GEMINI_AUTO_FALLBACK_MODEL, reason: 'Auto-routing failed, using fallback model.' };
    }

    async sendMessage(input) {
        await this.ensureRuntime();

        let message = '';
        let images = [];
        if (typeof input === 'string') {
            message = input;
        } else {
            message = input.text;
            images = input.images || [];
        }

        let activeModel = this.modelName;
        if (this.modelName === 'auto') {
            const routing = await this.autoRoute(message);
            activeModel = routing.model;
            if (!this.config.isApiMode) {
                console.log(chalk.magenta(`\n[Auto Mode] → ${chalk.yellow(activeModel)}: ${routing.reason}`));
            }
        }

        const userParts = [{ text: message }];
        for (const image of images) {
            userParts.push({
                inlineData: {
                    mimeType: image.mimeType,
                    data: image.base64
                }
            });
        }
        this.messages.push({ role: 'user', parts: userParts });

        let spinner = null;
        if (!this.config.isApiMode) {
            spinner = ora({
                text: this._runtime.getRandomSpinnerText('gemini'),
                color: 'yellow',
                stream: process.stdout
            }).start();
        }

        let responseText = '';

        try {
            while (true) {
                let currentTurnText = '';
                const response = await this.requestCodeAssist('streamGenerateContent', activeModel, {
                    contents: this.messages,
                    systemInstruction: { parts: [{ text: this.systemPrompt }] },
                    tools: [{ functionDeclarations: this.tools }]
                }, { streaming: true });

                if (!response.ok) {
                    const errorText = await response.text();
                    this.markModelUnavailable(activeModel);
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';
                const aggregatedParts = [];

                while (true) {
                    const { done, value } = await reader.read();
                    if (value) {
                        buffer += decoder.decode(value, { stream: true });
                    }

                    buffer = buffer.replace(/\r\n/g, '\n');
                    const sseParts = buffer.split('\n\n');

                    if (!done) {
                        buffer = sseParts.pop() || '';
                    } else {
                        buffer = '';
                    }

                    for (const ssePart of sseParts) {
                        const line = ssePart.trim();
                        if (!line.startsWith('data: ')) {
                            continue;
                        }

                        const dataStr = line.slice(6).trim();
                        if (dataStr === '[DONE]' || !dataStr) {
                            continue;
                        }

                        let data;
                        try {
                            data = JSON.parse(dataStr);
                        } catch {
                            continue;
                        }

                        data = unwrapCodeAssistResponse(data);

                        const content = data.candidates?.[0]?.content;
                        if (!content?.parts) {
                            continue;
                        }

                        for (const part of content.parts) {
                            if (part.text) {
                                if (spinner?.isSpinning && !this.config.useMarkedTerminal) {
                                    spinner.stop();
                                }

                                if (!this.config.useMarkedTerminal) {
                                    if (this.config.isApiMode && this.onChunk) {
                                        this.onChunk(part.text);
                                    } else {
                                        process.stdout.write(chalk.cyan(part.text));
                                    }
                                }

                                responseText += part.text;
                                currentTurnText += part.text;

                                const lastPart = aggregatedParts[aggregatedParts.length - 1];
                                if (lastPart?.text !== undefined) {
                                    lastPart.text += part.text;
                                } else {
                                    aggregatedParts.push({ text: part.text });
                                }
                                continue;
                            }

                            if (part.functionCall) {
                                aggregatedParts.push(part);

                                if (spinner) {
                                    if (spinner.isSpinning) {
                                        spinner.stop();
                                    }
                                    const call = part.functionCall;
                                    const argSize = JSON.stringify(call.args || {}).length;
                                    spinner = ora({
                                        text: `Generating ${chalk.yellow(call.name)} arguments (${argSize} bytes)...`,
                                        color: 'yellow',
                                        stream: process.stdout
                                    }).start();
                                }
                                continue;
                            }

                            aggregatedParts.push(part);
                        }
                    }

                    if (done) {
                        break;
                    }
                }

                if (spinner?.isSpinning) {
                    spinner.stop();
                }

                if (currentTurnText && this.config.useMarkedTerminal) {
                    this._runtime.printMarkdown(currentTurnText);
                }

                if (aggregatedParts.length === 0) {
                    break;
                }

                this.messages.push({ role: 'model', parts: aggregatedParts });

                let hasToolCalls = false;
                const toolResults = [];

                for (const part of aggregatedParts) {
                    if (!part.functionCall) {
                        continue;
                    }

                    hasToolCalls = true;
                    const call = part.functionCall;
                    if (this.config.isApiMode && this.onToolStart) {
                        this.onToolStart(call.name);
                    }
                    if (!this.config.isApiMode) {
                        console.log(chalk.yellow(`\n[Banana Calling Tool: ${call.name}]`));
                    }

                    const result = await this._runtime.executeTool(call.name, call.args, this.config);

                    if (this.config.isApiMode && this.onToolEnd) {
                        this.onToolEnd(result);
                    }
                    if (this.config.debug && !this.config.isApiMode) {
                        console.log(chalk.gray(`[DEBUG] Tool Result: ${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`));
                    }
                    if (!this.config.isApiMode) {
                        console.log(chalk.yellow('[Tool Result Received]\n'));
                    }

                    toolResults.push({
                        functionResponse: {
                            name: call.name,
                            response: { result }
                        }
                    });
                }

                if (!hasToolCalls) {
                    break;
                }

                this.messages.push({ role: 'user', parts: toolResults });
                if (!this.config.isApiMode) {
                    spinner = ora({ text: 'Processing tool results...', color: 'yellow', stream: process.stdout }).start();
                }
            }

            if (!this.config.isApiMode) {
                console.log();
            }
            return responseText;
        } catch (error) {
            if (spinner?.isSpinning) {
                spinner.stop();
            }

            if (!this.config.isApiMode) {
                console.error(chalk.red(`Gemini OAuth Error: ${error.message}`));
            }

            return `Error: ${error.message}`;
        }
    }
}
