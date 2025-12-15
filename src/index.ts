<<<<<<< HEAD
// src/index.ts

import { Env, ChatMessage } from "./types";
import { v4 as uuidv4 } from 'uuid'; // 引入 UUID 库生成唯一 ID

// --- 1. 常量与全局状态 ---

// Workers AI 模型 ID
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; 
const SYSTEM_PROMPT = "You are a helpful, friendly assistant. Provide concise and accurate responses.";

// 存储 AbortController 的 Map，用于实现取消机制 (P0)
// Map 的 Key 是 conversationId，Value 是 AbortController 实例。
const ongoingRequests = new Map<string, AbortController>(); 

// --- 2. Worker 主入口 ---

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // 静态资产路由
        if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }

        // API 路由
        if (url.pathname === "/api/chat") {
            if (request.method === "POST") {
                return handleChatRequest(request, env, ctx);
            }
        } 
        
        // 取消路由 (P0)
        if (url.pathname.startsWith("/api/chat/") && url.pathname.endsWith("/cancel")) {
             if (request.method === "POST") {
                const conversationId = url.pathname.split('/')[3];
                return handleCancelRequest(conversationId, env, ctx);
            }
        }
        
        // 历史记录路由 (P0)
        if (url.pathname === "/api/history") {
            if (request.method === "GET") {
                const conversationId = url.searchParams.get('id');
                return handleHistoryRequest(conversationId, env);
            }
        }

        // 404 路由
        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;


// --- 3. 核心 API 处理函数 ---

/**
 * 处理 POST /api/chat 请求，管理上下文，并处理流式响应。
 */
async function handleChatRequest(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
): Promise<Response> {
    const { message: newMessage, conversationId: inputId } = (await request.json()) as {
        message: string;
        conversationId?: string;
    };
    
    let conversationId = inputId || uuidv4(); // 为新对话生成唯一 ID (P0)
    let history: ChatMessage[] = [];
    
    // --- 3.1 上下文读取 (P0) ---
    if (inputId) {
        const historyJson = await env.CHAT_CONTEXT_KV.get(inputId);
        if (historyJson) {
            // 注意: KV 存储的值需要解析
            const data = JSON.parse(historyJson);
            history = data.messages || [];
        }
    }

    // 组装完整的对话消息列表
    history.push({ role: "user", content: newMessage });
    
    // 确保系统提示在最前面
    if (!history.some((msg) => msg.role === "system")) {
        history.unshift({ role: "system", content: SYSTEM_PROMPT });
    }
    
    // 创建 AbortController 用于取消 (P0)
    const controller = new AbortController();
    ongoingRequests.set(conversationId, controller);
    
    // --- 3.2 自定义流式处理 (P0) ---

    // 1. 设置 Workers AI 的 fetch 参数
    // const aiApiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/run/${MODEL_ID}`; 
    // 注意：您需要在 wrangler.json 的 vars 中或作为 Secret 添加 ACCOUNT_ID
    
    // 2. 向 Workers AI 发起请求 (使用标准 fetch)
	const aiResponse = await env.AI.run(
		MODEL_ID,
		{
			messages: history,
			stream: true, // 启用流式传输
		},
		{ signal: controller.signal } // 绑定 AbortController
	);

	if (!aiResponse.body) {
		return new Response("No response body from AI", { status: 500 });
	}
    
    // 3. 创建自定义 ReadableStream 来代理、捕获和格式化数据 (P0)
    let assistantResponseText = "";
    
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = aiResponse.body.getReader();
    const decoder = new TextDecoder();
    
    // 异步处理 LLM 流
    const processStream = async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                
                // Cloudflare / OpenAI API 返回的 SSE 数据解析 (可能需要根据实际格式调整)
                const lines = chunk.split('\n').filter(l => l.trim().startsWith('data:'));

                for (const line of lines) {
                    try {
                        const data = JSON.parse(line.substring(5).trim()); // 移除 "data: "
                        
                        // 提取 LLM 生成的文本
                        const content = data.response || (data.choices && data.choices[0]?.delta?.content) || '';
                        
                        if (content) {
                            assistantResponseText += content;
                            
                            // 格式化为前端所需的 JSON 块 (示例: {"response": "..."})
                            const outputChunk = JSON.stringify({ response: content }) + '\n';
                            
                            // 实时转发给客户端
                            await writer.write(new TextEncoder().encode(outputChunk));
                        }
                        
                    } catch (e) {
                        // 忽略解析错误
                        console.log("Partial data chunk:", line);
                    }
                }
            }
            
            // 流式传输完成
            await writer.close(); 
            
            // --- 3.3 异步持久化 (P0) ---
            if (assistantResponseText) {
                history.push({ role: "assistant", content: assistantResponseText });
                const historyValue = JSON.stringify({ messages: history, interrupted: false });
                
                // 使用 waitUntil 确保 KV 写入在 Worker 退出前完成，而不阻塞响应
                ctx.waitUntil(env.CHAT_CONTEXT_KV.put(conversationId, historyValue));
            }
            
        } catch (error) {
            // 捕获取消或网络错误
            const isAborted = error instanceof DOMException && error.name === 'AbortError';
            console.error(isAborted ? "Request aborted." : "Streaming error:", error);

            // 即使中断，也要保存已生成的内容 (P0)
            if (assistantResponseText) {
                history.push({ role: "assistant", content: assistantResponseText });
                const historyValue = JSON.stringify({ messages: history, interrupted: isAborted });
                ctx.waitUntil(env.CHAT_CONTEXT_KV.put(conversationId, historyValue));
            }

            await writer.abort(error);

        } finally {
            // 移除 AbortController，清理内存
            ongoingRequests.delete(conversationId);
        }
    };

    // 在 Worker 线程中启动流处理，同时返回响应
    ctx.waitUntil(processStream());

    // 返回流式响应
    return new Response(readable, {
        headers: {
            "Content-Type": "text/plain; charset=utf-8", // 使用 text/plain，前端解析 JSON 行
            "X-Conversation-Id": conversationId, // 将 ID 返回给前端用于后续请求
        },
    });
}

// --- 4. 辅助 API 处理函数 ---

/**
 * 处理 POST /api/chat/:id/cancel 请求，中止 LLM 生成 (P0)。
 */
async function handleCancelRequest(conversationId: string, env: Env, ctx: ExecutionContext): Promise<Response> {
    const controller = ongoingRequests.get(conversationId);
    
    if (controller) {
        controller.abort(); // 立即中止 LLM API 的 fetch 请求
        ongoingRequests.delete(conversationId);
        return new Response("Generation cancelled.", { status: 200 });
    }
    
    return new Response("No ongoing request found.", { status: 404 });
}

/**
 * 处理 GET /api/history 请求，从 KV 读取历史记录 (P0)。
 */
async function handleHistoryRequest(conversationId: string | null, env: Env): Promise<Response> {
    if (!conversationId) {
        return new Response(JSON.stringify({ error: "Missing conversationId" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    try {
        const historyJson = await env.CHAT_CONTEXT_KV.get(conversationId);

        if (historyJson) {
            return new Response(historyJson, {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        } else {
            return new Response(JSON.stringify({ error: "Conversation not found" }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
            });
        }
    } catch (e) {
        console.error("KV read error:", e);
        return new Response(JSON.stringify({ error: "Failed to fetch history" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
}
=======
/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

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

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// API Routes
		if (url.pathname === "/api/chat") {
			// Handle POST requests for chat
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		// Parse JSON request body
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		// Add system prompt if not present
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}

		const response = (await env.AI.run(
			MODEL_ID,
			{
				messages,
				max_tokens: 1024,
			},
			// @ts-expect-error tags is no longer required
			{
				returnRawResponse: true,
				// Uncomment to use AI Gateway
				// gateway: {
				//   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
				//   skipCache: false,      // Set to true to bypass cache
				//   cacheTtl: 3600,        // Cache time-to-live in seconds
				// },
			},
		)) as unknown as Response;

		// Return streaming response
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
>>>>>>> 16af6b9 (source repo import)
