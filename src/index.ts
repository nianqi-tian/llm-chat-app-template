/**
 * LLM Chat Application Template
 *
 * 这是一个使用 Cloudflare Workers AI 构建的简单聊天应用的模板。
 * 它展示了如何通过 Server-Sent Events (SSE) 实现 LLM 驱动的聊天界面的流式响应。
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types"; // 导入环境变量 (Env) 和聊天消息类型 (ChatMessage)

// --- 1. 常量定义 ---

// Workers AI 模型 ID
// 此处使用的是一个大型 Llama 模型，Workers AI 会自动处理模型的运行和优化。
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// 默认的系统提示 (System Prompt)
// 用于设定 AI 助手的行为和语气。
const SYSTEM_PROMPT =
    "You are a helpful, friendly assistant. Provide concise and accurate responses.";

// --- 2. Worker 主导出对象 (实现了 ExportedHandler 接口) ---
export default {
    /**
     * Main request handler for the Worker
     * Worker 的主要请求处理程序，类似于 Express 或 Koa 的入口。
     */
    async fetch(
        request: Request,
        env: Env, // 环境变量，包含了 AI 绑定、KV 存储等
        ctx: ExecutionContext, // 执行上下文，用于 event.waitUntil() 等操作
    ): Promise<Response> {
        const url = new URL(request.url);

        // --- 3. 静态资产和路由处理 ---

        // 处理静态资产 (Frontend / UI)
        // 如果路径是根路径 ("/") 或不以 "/api/" 开头，则视为请求静态文件。
        // `env.ASSETS.fetch(request)` 会将请求代理到 R2 存储的静态文件。
        if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }

        // API 路由
        if (url.pathname === "/api/chat") {
            // 处理 POST 请求 (用户发送新消息)
            if (request.method === "POST") {
                return handleChatRequest(request, env);
            }

            // 方法不允许 (如 GET /api/chat)
            return new Response("Method not allowed", { status: 405 });
        }

        // 处理 404 (未匹配的路由)
        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>; // 确保导出的对象符合 Worker 规范

/**
 * 核心逻辑：处理聊天 API 请求 (POST /api/chat)
 * 这是集成 Workers AI 的关键函数。
 */
async function handleChatRequest(
    request: Request,
    env: Env,
): Promise<Response> {
    try {
        // 1. 解析请求体，提取对话历史
        const { messages = [] } = (await request.json()) as {
            messages: ChatMessage[];
        };

        // 2. 检查并添加 System Prompt
        // 确保对话历史中包含系统提示，以指导 LLM 的行为。
        if (!messages.some((msg) => msg.role === "system")) {
            messages.unshift({ role: "system", content: SYSTEM_PROMPT });
        }
        
        // 

        // 3. 调用 Workers AI SDK 运行 LLM 模型
        const response = (await env.AI.run(
            MODEL_ID, // 指定使用的 LLM 模型
            {
                messages, // 传入完整的上下文 (包含 System Prompt)
                max_tokens: 1024, // 限制回复的最大 Token 长度
            },
            {
                // returnRawResponse: true 是这里的关键！
                // 它指示 AI SDK 不要等待完整的 JSON 结果，而是直接返回
                // LLM 生成的流式 HTTP 响应，并将其代理给客户端。
                returnRawResponse: true,
                // @ts-expect-error tags is no longer required
            },
        )) as unknown as Response;

        // 4. 返回流式响应
        // 由于设置了 returnRawResponse: true，这里的 response 就是 LLM API 的实时流。
        // Worker 充当了高效的代理，将 LLM 的 SSE 数据流转发给前端，实现了 P0 中的“标准流式传输”。
        return response;
        
    } catch (error) {
        // 5. 错误处理
        console.error("Error processing chat request:", error);
        return new Response(
            JSON.stringify({ error: "Failed to process request" }),
            {
                status: 500, // 返回 500 状态码表示服务器内部错误
                headers: { "content-type": "application/json" },
            },
        );
    }
}