/**
 * LLM Chat Application Template (最终修正版本：KV持久化、流式兼容、路由)
 *
 * 解决流式传输、ID生成和历史记录读取问题。
 * @license MIT
 */
import { v4 as uuidv4 } from 'uuid'; 
import { Env, ChatMessage, ConversationHistory, Message } from "./types";

// --- 全局状态：用于实现取消功能 ---
const activeControllers = new Map<string, AbortController>(); 

// --- 配置常量 ---
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; 
const SYSTEM_PROMPT = "You are a helpful, friendly assistant. Provide concise and accurate responses.";

// --- 辅助函数：KV 历史记录管理 ---

async function readHistory(env: Env, conversationId: string): Promise<ConversationHistory> {
    if (!conversationId) {
        return [];
    }
    
    try {
        // 尝试从 KV 获取数据
        const historyJson = await env.CHAT_HISTORY.get(conversationId);
        
        if (historyJson) {
            // 确保解析成功，如果失败会进入 catch 块
            return JSON.parse(historyJson) as ConversationHistory;
        }
        
    } catch (error) {
        // 记录 KV 读取或解析失败的详细错误，这通常是历史记录不显示的根源之一
        console.error(`[KV ERROR] Read/Parse failed for ${conversationId}:`, error); 
    }
    return []; 
}


async function saveConversation(
    env: Env,
    conversationId: string,
    history: ConversationHistory 
): Promise<void> {
    try {
        const historyJsonString = JSON.stringify(history);
        await env.CHAT_HISTORY.put(conversationId, historyJsonString);
    } catch (error) {
        console.error(`[KV ERROR] Write failed for ${conversationId}:`, error);
    }
}

// --- API 处理函数：历史记录提取 ---

async function handleGetHistory(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('id'); 

    if (!conversationId) {
        return new Response(JSON.stringify({ error: "请求缺少 conversationId 参数" }), { 
            status: 400, 
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const history = await readHistory(env, conversationId);

        return new Response(JSON.stringify({ 
            conversationId, 
            history 
        }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error) {
        console.error(`[API ERROR] Failed to retrieve history for ${conversationId}:`, error);
        return new Response(JSON.stringify({ error: "服务器内部错误，无法加载历史记录" }), { 
            status: 500, 
            headers: { 'Content-Type': 'application/json' }
        });
    }
}


// --- API 处理函数：取消请求 ---

async function handlePostCancel(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    const conversationId = pathSegments[pathSegments.length - 2]; 

    if (!conversationId) {
        return new Response('缺少 conversationId', { status: 400 });
    }

    const controller = activeControllers.get(conversationId);
    
    if (controller) {
        controller.abort(); 
        activeControllers.delete(conversationId);
        
        console.log(`对话 ${conversationId} 已成功被用户取消。`);
        return new Response(JSON.stringify({ status: 'cancelled' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } else {
        return new Response(JSON.stringify({ status: 'no active request found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}


// --- API 处理函数：核心聊天逻辑 ---

async function handlePostChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
        const { messages: frontendMessages = [], conversationId: oldConversationId } = (await request.json()) as {
            messages: ChatMessage[]; 
            conversationId?: string; 
        };

        // 🚨 修正：确保在旧 ID 为 null 或 undefined 时，能正确生成新 ID
        const conversationId = oldConversationId && oldConversationId !== 'null' ? oldConversationId : uuidv4(); 
        
        // 1. 设置 AbortController
        const controller = new AbortController();
        activeControllers.set(conversationId, controller);
        
        // 2. 读取上下文
        const history = await readHistory(env, conversationId);

        // 3. 构建发送给 AI 的完整消息列表 (省略构建过程，已在之前代码中实现)
        const userMessageContent = frontendMessages[frontendMessages.length - 1].content;
        
        const userMessage: Message = {
            role: 'user',
            content: userMessageContent,
            timestamp: Date.now(),
        };

        let messagesForAI: ChatMessage[] = history.map(m => ({
            role: m.role,
            content: m.content
        } as ChatMessage));
        
        if (!messagesForAI.some((msg) => msg.role === "system")) {
            messagesForAI.unshift({ role: "system", content: SYSTEM_PROMPT });
        }
        messagesForAI.push(userMessage as ChatMessage);

        // 4. 调用 Workers AI
        const llmResponse = (await env.AI.run(
            MODEL_ID,
            {
                messages: messagesForAI,
                max_tokens: 1024,
            },
            {
                signal: controller.signal, 
                returnRawResponse: true,
            },
        )) as unknown as Response;

        if (!llmResponse.ok) {
            console.error("Workers AI 原始调用失败，状态码:", llmResponse.status);
            // 尝试返回错误信息，而不是一个破碎的流
            return new Response(JSON.stringify({ error: "LLM Provider Error" }), { status: 502, headers: { 'Content-Type': 'application/json' }});
        }

        // 5. 提取流并设置持久化逻辑
        let fullAiResponseContent = '';
        let isInterrupted = false;
        
        const [stream1, stream2] = llmResponse.body!.tee(); 

        ctx.waitUntil((async () => {
            try {
                const reader = stream1.getReader();
                const decoder = new TextDecoder();
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    // 确保我们收集的是纯文本
                    fullAiResponseContent += decoder.decode(value);
                }
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    isInterrupted = true;
                } else {
                    console.error("AI.run 流收集错误:", error);
                }
            } finally {
                // 6. 清理和持久化
                activeControllers.delete(conversationId); 
                
                const aiMessage: Message = {
                    role: 'assistant',
                    content: fullAiResponseContent,
                    timestamp: Date.now(),
                    interrupted: isInterrupted,
                };
                
                const updatedHistory = [...history, userMessage, aiMessage];
                await saveConversation(env, conversationId, updatedHistory); 
                console.log(`对话 ${conversationId} 保存完成。`);
            }
        })());

        // 7. 立即返回流式响应
        const response = new Response(stream2, {
            status: llmResponse.status,
            headers: {
                ...llmResponse.headers,
                'Content-Type': 'text/event-stream', 
                'X-Conversation-ID': conversationId, // 关键：返回 ID 给前端
            },
        });
        return response;

    } catch (error) {
        console.error("Error processing chat request:", error);
        return new Response(
            JSON.stringify({ error: "Failed to process request" }),
            {
                status: 500,
                headers: { "content-type": "application/json" },
            },
        );
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