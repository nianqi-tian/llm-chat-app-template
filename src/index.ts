/**
 * LLM Chat Application Template (最终修正 V3：强制流式传输)
 */
import { v4 as uuidv4 } from 'uuid'; 
import { Env, ChatMessage, ConversationHistory, Message } from "./types";

// ... (全局状态、常量、readHistory, saveConversation, handleGetHistory, handlePostCancel 保持不变) ...
// --- 运行时可变配置 & 全局状态 ---
const activeControllers = new Map<string, AbortController>(); 

// 默认模型与参数，可通过环境变量覆盖（参见 wrangler.jsonc vars）
const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_MAX_CONTEXT_TOKENS = 4000;

const BASE_SYSTEM_PROMPT = "You are a helpful, friendly assistant. Provide concise and accurate responses.";

async function readHistory(env: Env, conversationId: string): Promise<ConversationHistory> {
    if (!conversationId) return [];
    try {
        const historyJson = await env.CHAT_HISTORY.get(conversationId);
        if (historyJson) return JSON.parse(historyJson) as ConversationHistory;
    } catch (error) {
        console.error(`[KV ERROR] Read/Parse failed for ${conversationId}:`, error); 
    }
    return []; 
}

async function saveConversation(env: Env, conversationId: string, history: ConversationHistory): Promise<void> {
    try {
        const historyJsonString = JSON.stringify(history);
        await env.CHAT_HISTORY.put(conversationId, historyJsonString);
    } catch (error) {
        console.error(`[KV ERROR] Write failed for ${conversationId}:`, error);
    }
}

async function handleGetHistory(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('id'); 
    if (!conversationId) return new Response(JSON.stringify({ error: "请求缺少 conversationId 参数" }), { status: 400, headers: { 'Content-Type': 'application/json' }});
    try {
        const history = await readHistory(env, conversationId);
        return new Response(JSON.stringify({ conversationId, history }), { headers: { 'Content-Type': 'application/json' }, status: 200, });
    } catch (error) {
        console.error(`[API ERROR] Failed to retrieve history for ${conversationId}:`, error);
        return new Response(JSON.stringify({ error: "服务器内部错误，无法加载历史记录" }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }
}

async function handlePostCancel(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    const conversationId = pathSegments[pathSegments.length - 2]; 

    const controller = activeControllers.get(conversationId);
    if (controller) {
        controller.abort(); 
        activeControllers.delete(conversationId);
        return new Response(JSON.stringify({ status: 'cancelled' }), { status: 200, headers: { 'Content-Type': 'application/json' },});
    } else {
        return new Response(JSON.stringify({ status: 'no active request found' }), { status: 404, headers: { 'Content-Type': 'application/json' },});
    }
}


// --- 简单 Token 估算与裁剪 ---
function estimateTokensFromMessages(messages: ChatMessage[]): number {
    // 非精确估算：假设 4 字符 ≈ 1 token
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / 4);
}

function trimMessagesToTokenLimit(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
    // 保留最后的对话轮次与 system 提示，丢弃最早的 user/assistant 内容
    if (estimateTokensFromMessages(messages) <= maxTokens) return messages;

    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    while (nonSystem.length > 0 && estimateTokensFromMessages([...systemMessages, ...nonSystem]) > maxTokens) {
        nonSystem.shift(); // 丢弃最早的一条
    }
    return [...systemMessages, ...nonSystem];
}


// --- 核心聊天逻辑：最终修正 ---
async function handlePostChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
        const body = (await request.json()) as {
            messages?: ChatMessage[];
            conversationId?: string | null;
            options?: {
                model?: string;
                temperature?: number;
                max_tokens?: number;
                webSearchEnabled?: boolean;
            };
        };

        const frontendMessages = body.messages ?? [];
        const oldConversationId = body.conversationId;

        if (!Array.isArray(frontendMessages) || frontendMessages.length === 0) {
            return new Response(JSON.stringify({ error: "请求体中缺少有效的 messages 数组" }), {
                status: 400,
                headers: { "content-type": "application/json" },
            });
        }

        const lastMsg = frontendMessages[frontendMessages.length - 1];
        if (!lastMsg || lastMsg.role !== "user" || typeof lastMsg.content !== "string" || !lastMsg.content.trim()) {
            return new Response(JSON.stringify({ error: "最后一条消息必须是非空的用户消息" }), {
                status: 400,
                headers: { "content-type": "application/json" },
            });
        }

        // 🚨 修正 ID 逻辑：确保旧 ID 为 'null' 或 undefined/null 时生成新 ID
        const conversationId = oldConversationId && oldConversationId !== 'null' ? oldConversationId : uuidv4(); 
        
        const controller = new AbortController();
        activeControllers.set(conversationId, controller);
        
        const history = await readHistory(env, conversationId);
        const userMessageContent = lastMsg.content.trim();
        
        const userMessage: Message = { role: 'user', content: userMessageContent, timestamp: Date.now() };

        let messagesForAI: ChatMessage[] = history.map(m => ({ role: m.role, content: m.content } as ChatMessage));
        
        const webSearchEnabled = body.options?.webSearchEnabled === true;
        let systemPrompt = BASE_SYSTEM_PROMPT;
        if (webSearchEnabled) {
            systemPrompt += " You may use web search or external knowledge if available to provide up-to-date information.";
        }

        if (!messagesForAI.some((msg) => msg.role === "system")) {
            messagesForAI.unshift({ role: "system", content: systemPrompt });
        } else {
            // 如果已经有 system 消息，保留最后一条，但追加 webSearch 说明
            messagesForAI = messagesForAI.map((m, idx) =>
                m.role === "system" && idx === messagesForAI.findLastIndex(mm => mm.role === "system")
                    ? { ...m, content: m.content + (webSearchEnabled ? "\n\n(当前会话允许使用 Web 搜索以提供尽量新的信息。)" : "") }
                    : m
            );
        }
        messagesForAI.push(userMessage as ChatMessage);

        // Token 估算与裁剪（包含用户新消息）
        const configuredMaxContextTokens = Number(env.MAX_CONTEXT_TOKENS ?? DEFAULT_MAX_CONTEXT_TOKENS);
        messagesForAI = trimMessagesToTokenLimit(messagesForAI, configuredMaxContextTokens);

        // 4. 调用 Workers AI（可配置的模型与参数）
        const modelId = body.options?.model || env.MODEL_ID || DEFAULT_MODEL_ID;
        const temperature =
            typeof body.options?.temperature === "number"
                ? body.options.temperature
                : Number(env.TEMPERATURE ?? DEFAULT_TEMPERATURE);
        const maxOutputTokens =
            typeof body.options?.max_tokens === "number"
                ? body.options.max_tokens
                : Number(env.MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS);

        const requestStart = Date.now();

        // 简单的一次重试机制：如果第一次调用出现网络类错误，再尝试一次
        async function callModelOnce(): Promise<Response> {
            return (await env.AI.run(
                modelId,
                { messages: messagesForAI, max_tokens: maxOutputTokens, temperature },
                { signal: controller.signal, returnRawResponse: true },
            )) as unknown as Response;
        }

        let llmResponse: Response;
        try {
            llmResponse = await callModelOnce();
        } catch (err) {
            console.warn("[LLM] 第一次调用失败，尝试重试一次:", err);
            llmResponse = await callModelOnce();
        }

        if (!llmResponse.ok) {
            console.error("Workers AI 原始调用失败，状态码:", llmResponse.status);
            return new Response(JSON.stringify({ error: "LLM Provider Error" }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 5. 提取流并设置持久化逻辑
        let fullAiResponseContent = '';
        let isInterrupted = false;
        
        // 使用 llmResponse.body.pipeThrough() 创建一个新的流，确保它能被正确识别为流式传输
        // 🚨 修正：使用 pipeTo() 来收集内容，并创建一个新的响应流
        const [streamForSaving, streamForResponse] = llmResponse.body!.tee();

        ctx.waitUntil((async () => {
            try {
                const reader = streamForSaving.getReader();
                const decoder = new TextDecoder();
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    fullAiResponseContent += decoder.decode(value);
                }
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    isInterrupted = true;
                } else {
                    console.error("AI.run 流收集错误:", error);
                }
            } finally {
                activeControllers.delete(conversationId); 
                
                const aiMessage: Message = {
                    role: 'assistant',
                    content: fullAiResponseContent,
                    timestamp: Date.now(),
                    interrupted: isInterrupted,
                };
                
                const updatedHistory = [...history, userMessage, aiMessage];
                await saveConversation(env, conversationId, updatedHistory); 

                const elapsedMs = Date.now() - requestStart;
                const promptTokens = estimateTokensFromMessages(messagesForAI);
                const completionTokens = Math.ceil(fullAiResponseContent.length / 4);
                console.log(
                    `[METRICS] conversationId=${conversationId} model=${modelId} webSearch=${webSearchEnabled} ` +
                    `promptTokens=${promptTokens} completionTokens=${completionTokens} durationMs=${elapsedMs}`
                );
            }
        })());

        // 7. 返回流式响应
        const response = new Response(streamForResponse, {
            status: llmResponse.status,
            headers: {
                ...llmResponse.headers,
                // 确保 Content-Type 至少是 text/plain 或 application/octet-stream，
                // 浏览器通常会将其视为流式传输
                'Content-Type': 'text/plain', 
                'X-Conversation-ID': conversationId, 
            },
        });
        return response;

    } catch (error) {
        console.error("Error processing chat request:", error);
        return new Response(JSON.stringify({ error: "Failed to process request" }), {
            status: 500,
            headers: { "content-type": "application/json" },
        });
    }
}


// --- 简单内存级 Rate Limiting（单 Worker 实例级别，防止滥用） ---
const rateLimitMap = new Map<string, { windowStart: number; count: number }>();

function getClientKey(request: Request): string {
    // 在 Workers 中可以通过 request.headers.get("CF-Connecting-IP") 获取用户 IP
    return request.headers.get("CF-Connecting-IP") || "unknown";
}

function checkRateLimit(request: Request, env: Env): { allowed: boolean; retryAfterSec?: number } {
    const key = getClientKey(request);
    const now = Date.now();

    const windowSec = Number(env.RATE_LIMIT_WINDOW_SEC ?? 60);
    const maxRequests = Number(env.RATE_LIMIT_MAX_REQUESTS ?? 30);
    const windowMs = windowSec * 1000;

    const record = rateLimitMap.get(key);

    if (!record || now - record.windowStart >= windowMs) {
        rateLimitMap.set(key, { windowStart: now, count: 1 });
        return { allowed: true };
    }

    if (record.count < maxRequests) {
        record.count += 1;
        return { allowed: true };
    }

    const retryAfterSec = Math.ceil((record.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfterSec };
}


export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            const headers = {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-Conversation-ID',
                'Access-Control-Max-Age': '86400',
            };
            return new Response(null, { status: 204, headers });
        }

        // 静态资源
        if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }

        // 历史记录读取
        if (url.pathname.startsWith("/api/history") && request.method === "GET") {
            return handleGetHistory(request, env);
        }

        // 取消生成
        if (request.method === 'POST' && url.pathname.match(/\/api\/chat\/[^/]+\/cancel$/)) {
            return handlePostCancel(request);
        }

        // Rate limit 主要针对聊天接口
        if (url.pathname === "/api/chat" && request.method === "POST") {
            const rl = checkRateLimit(request, env);
            if (!rl.allowed) {
                return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试。" }), {
                    status: 429,
                    headers: {
                        "content-type": "application/json",
                        "Retry-After": String(rl.retryAfterSec ?? 60),
                    },
                });
            }
            return handlePostChat(request, env, ctx); 
        }

        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;