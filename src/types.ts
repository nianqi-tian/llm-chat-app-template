/**
 * Type definitions for the LLM chat application.
 *
 * 此文件定义了 Worker 脚本中使用的主要类型和接口，包括环境变量 (Env) 和对话消息结构 (ChatMessage)。
 */

// --- 1. Worker 环境变量接口 ---
// 此接口定义了通过 Cloudflare Worker 绑定 (Bindings) 注入到 Worker 运行时环境中的资源。
export interface Env {
    /**
     * Binding for the Workers AI API.
     *
     * 对应于 `wrangler.toml` 中配置的 AI 服务绑定。
     * 通过此对象，Worker 脚本可以调用 Cloudflare Workers AI 的 run() 方法来执行 LLM 模型。
     */
    AI: Ai;

    /**
     * Binding for static assets.
     *
     * 对应于 `wrangler.toml` 中配置的静态资产绑定，用于服务前端 UI 文件（HTML, CSS, JS）。
     * `fetch` 方法用于代理对静态文件的请求。
     */
    ASSETS: { fetch: (request: Request) => Promise<Response> };
    
    // 注意：如果需要实现 P0 清单中的“对话上下文管理”，您还需要在此处添加 KV 存储绑定：
    // CHAT_CONTEXT_KV: KVNamespace; 
	// 新增：KV 存储绑定
    CHAT_CONTEXT_KV: KVNamespace; 
    
    // 示例：可以添加配置变量
    SYSTEM_PROMPT: string;
}

/**
 * Represents a chat message.
 *
 * 定义了对话中单个消息的标准结构，符合大多数主流 LLM API (如 OpenAI/Workers AI) 的消息格式。
 */
export interface ChatMessage {
    /**
     * The role of the message sender.
     *
     * 消息发送者的角色：
     * - "system": 用于设置 LLM 的行为和初始指令。
     * - "user": 用户的输入消息。
     * - "assistant": LLM 的回复消息。
     */
    role: "system" | "user" | "assistant";
    
    /**
     * The content of the message.
     *
     * 消息的文本内容。
     */
    content: string;
}