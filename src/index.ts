/**
 * LLM Chat Application Template (Integrated with KV History and Routing)
 *
 * This version implements conversation history persistence using Cloudflare KV,
 * custom routing, and integrates the logic within the provided Workers AI template.
 * @license MIT
 */
import { v4 as uuidv4 } from 'uuid'; 
import { Env, ChatMessage, ConversationHistory, Message } from "./types";

// --- 全局状态：用于实现取消功能 ---
const activeControllers = new Map<string, AbortController>(); 

// --- 配置常量 ---
// ⚠️ 请根据您的 Workers AI 配置调整 MODEL_ID
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; 
const SYSTEM_PROMPT = "You are a helpful, friendly assistant. Provide concise and accurate responses.";

// --- 辅助函数：KV 历史记录管理 ---

/**
 * 从 KV 存储中读取特定对话ID的历史记录。
 */
async function readHistory(env: Env, conversationId: string): Promise<ConversationHistory> {
    if (!conversationId) {
        return [];
    }
    
    try {
        const historyJson = await env.CHAT_HISTORY.get(conversationId);
        
        if (historyJson) {
            return JSON.parse(historyJson) as ConversationHistory;
        }
        
    } catch (error) {
        console.error(`KV Read Error for ${conversationId}:`, error);
    }
    return []; 
}


/**
 * 将完整的对话历史记录写入 KV 存储。
 */
async function saveConversation(
    env: Env,
    conversationId: string,
    history: ConversationHistory 
): Promise<void> {
    try {
        const historyJsonString = JSON.stringify(history);
        await env.CHAT_HISTORY.put(conversationId, historyJsonString);
        
    } catch (error) {
        console.error(`KV Write Error for ${conversationId}:`, error);
    }
}

// --- API 处理函数：历史记录提取 ---

/**
 * 处理 GET /api/history 请求，用于加载单个对话的完整历史记录。
 */
async function handleGetHistory(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // ⚠️ 前端将通过 ?id=xxx 获取记录
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
        console.error(`Failed to retrieve history for ${conversationId}:`, error);
        return new Response(JSON.stringify({ error: "服务器内部错误，无法加载历史记录" }), { 
            status: 500, 
            headers: { 'Content-Type': 'application/json' }
        });
    }
}


// --- API 处理函数：取消请求 ---

/**
 * 处理 POST /api/chat/:id/cancel 请求，用于中止当前活跃的 LLM 请求。
 */
async function handlePostCancel(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathSegments = url.pathname.split('/');
    // 提取 URL 中倒数第二个段作为 ID
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
        // 约定：前端只发送最新的用户消息和旧的 conversationId
        const { messages: frontendMessages = [], conversationId: oldConversationId } = (await request.json()) as {
            messages: ChatMessage[]; 
            conversationId?: string; 
        };

        const conversationId = oldConversationId || uuidv4(); 
        
        // 1. 设置 AbortController，用于取消
        const controller = new AbortController();
        activeControllers.set(conversationId, controller);
        
        // 2. 读取上下文
        const history = await readHistory(env, conversationId);

        // 3. 构建发送给 AI 的完整消息列表
        const userMessageContent = frontendMessages[frontendMessages.length - 1].content;
        
        const userMessage: Message = {
            role: 'user',
            content: userMessageContent,
            timestamp: Date.now(),
        };

        // 构造发送给 Workers AI 的完整上下文
        let messagesForAI: ChatMessage[] = history.map(m => ({
            role: m.role,
            content: m.content
        } as ChatMessage));
        
        // 添加系统提示 (如果不存在)
        if (!messagesForAI.some((msg) => msg.role === "system")) {
            messagesForAI.unshift({ role: "system", content: SYSTEM_PROMPT });
        }
        // 添加本次用户消息
        messagesForAI.push(userMessage as ChatMessage);

        // 4. 调用 Workers AI
        const llmResponse = (await env.AI.run(
            MODEL_ID,
            {
                messages: messagesForAI,
                max_tokens: 1024,
            },
            {
                // 传入 AbortSignal 实现取消
                signal: controller.signal, 
                returnRawResponse: true,
            },
        )) as unknown as Response;

        // 5. 提取流并设置持久化逻辑
        let fullAiResponseContent = '';
        let isInterrupted = false;
        
        // tee() 用于克隆流，以便可以同时读取并返回给客户端
        const [stream1, stream2] = llmResponse.body!.tee(); 

        // 异步处理流，并执行持久化操作 (使用 ctx.waitUntil 保证 worker 存活直到保存完成)
        ctx.waitUntil((async () => {
            try {
                const reader = stream1.getReader();
                const decoder = new TextDecoder();
                
                // 实时收集 AI 响应的全部内容
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    fullAiResponseContent += decoder.decode(value);
                }
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') {
                    isInterrupted = true;
                } else {
                    console.error("AI.run 流处理错误:", error);
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
                
                // 保存用户消息和 AI 回复
                const updatedHistory = [...history, userMessage, aiMessage];
                await saveConversation(env, conversationId, updatedHistory); 
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


export default {
    /**
     * Main request handler for the Worker
     */
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        const url = new URL(request.url);

        // 0. CORS 预检请求处理 (确保前端可以跨域请求)
        if (request.method === "OPTIONS") {
             const headers = {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-Conversation-ID',
                'Access-Control-Max-Age': '86400',
             };
             return new Response(null, { status: 204, headers });
        }


        // 1. 路由：静态资源 (前端)
        if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }

        // 2. 路由：GET /api/history?id=xxx (历史记录提取)
        if (url.pathname.startsWith("/api/history") && request.method === "GET") {
            return handleGetHistory(request, env);
        }

        // 3. 路由：POST /api/chat/:id/cancel (取消请求)
        if (request.method === 'POST' && url.pathname.match(/\/api\/chat\/[^/]+\/cancel$/)) {
             return handlePostCancel(request);
        }

        // 4. 路由：POST /api/chat (核心聊天)
        if (url.pathname === "/api/chat" && request.method === "POST") {
            return handlePostChat(request, env, ctx); 
        }

        // 5. 路由：未匹配到
        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;