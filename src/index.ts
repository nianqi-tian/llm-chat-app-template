/**
 * LLM Chat Application Template (最终修正 V3：强制流式传输)
 */
import { v4 as uuidv4 } from 'uuid'; 
import { Env, ChatMessage, ConversationHistory, Message } from "./types";

// ... (全局状态、常量、readHistory, saveConversation, handleGetHistory, handlePostCancel 保持不变) ...
const activeControllers = new Map<string, AbortController>(); 
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; 
const SYSTEM_PROMPT = "You are a helpful, friendly assistant. Provide concise and accurate responses.";

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


// --- 核心聊天逻辑：最终修正 ---
async function handlePostChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
        const { messages: frontendMessages = [], conversationId: oldConversationId } = (await request.json()) as {
            messages: ChatMessage[]; 
            conversationId?: string; 
        };

        // 🚨 修正 ID 逻辑：确保旧 ID 为 'null' 或 undefined/null 时生成新 ID
        const conversationId = oldConversationId && oldConversationId !== 'null' ? oldConversationId : uuidv4(); 
        
        const controller = new AbortController();
        activeControllers.set(conversationId, controller);
        
        const history = await readHistory(env, conversationId);
        const userMessageContent = frontendMessages[frontendMessages.length - 1].content;
        
        const userMessage: Message = { role: 'user', content: userMessageContent, timestamp: Date.now() };

        let messagesForAI: ChatMessage[] = history.map(m => ({ role: m.role, content: m.content } as ChatMessage));
        
        if (!messagesForAI.some((msg) => msg.role === "system")) {
            messagesForAI.unshift({ role: "system", content: SYSTEM_PROMPT });
        }
        messagesForAI.push(userMessage as ChatMessage);

        // 4. 调用 Workers AI
        const llmResponse = (await env.AI.run(
            MODEL_ID,
            { messages: messagesForAI, max_tokens: 1024 },
            { signal: controller.signal, returnRawResponse: true },
        )) as unknown as Response;

        if (!llmResponse.ok) {
            console.error("Workers AI 原始调用失败，状态码:", llmResponse.status);
            return new Response(JSON.stringify({ error: "LLM Provider Error" }), { status: 502, headers: { 'Content-Type': 'application/json' }});
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
                
                const aiMessage: Message = { role: 'assistant', content: fullAiResponseContent, timestamp: Date.now(), interrupted: isInterrupted };
                
                const updatedHistory = [...history, userMessage, aiMessage];
                await saveConversation(env, conversationId, updatedHistory); 
                console.log(`对话 ${conversationId} 保存完成。`);
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
        return new Response(JSON.stringify({ error: "Failed to process request" }), { status: 500, headers: { "content-type": "application/json" }});
    }
}


// ... (export default { fetch(...) 路由逻辑保持不变) ...
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

        if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }

        if (url.pathname.startsWith("/api/history") && request.method === "GET") {
            return handleGetHistory(request, env);
        }

        if (request.method === 'POST' && url.pathname.match(/\/api\/chat\/[^/]+\/cancel$/)) {
             return handlePostCancel(request);
        }

        if (url.pathname === "/api/chat" && request.method === "POST") {
            return handlePostChat(request, env, ctx); 
        }

        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;